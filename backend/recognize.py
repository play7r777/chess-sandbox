"""Position recognition from a screenshot.

Pipeline (best-to-worst):

1. **Multi-set template matching** — pre-loaded RGBA piece sprites from many
   piece sets (lichess SVGs, chess.com PNGs). For each detected square we
   estimate the background colour, build a binary "piece mask" by thresholding
   pixel deviation from background, and compare to each sprite's alpha mask
   via IoU + grayscale correlation on the silhouette. The piece set with the
   best aggregate score across the board "wins" and its votes determine the
   final position. Background-invariant by construction, so it works on
   chess.com / lichess / dark / blue / green / wood themes.

2. **chesscog** (optional) — if `chesscog` and its trained CNN weights are
   installed, we delegate to it first. It targets photographs of physical
   boards.

3. **Single-set template matching** (legacy fallback) — the original Cburnett-
   only pipeline, kept for completeness.

4. **Occupancy only** — last resort when no templates can be loaded.

Side-to-move and castling rights cannot be derived from a picture; they
default to "white to move, no rights" and the user fixes them in the UI.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)

PIECE_FEN_CHARS: tuple[str, ...] = ("P", "N", "B", "R", "Q", "K", "p", "n", "b", "r", "q", "k")
TEMPLATE_SIZE = 96  # pixels per side; square crop the user image is resized to

TEMPLATES_DIR = Path(__file__).resolve().parent / "templates_data"


@dataclass
class RecognitionResult:
    fen: str
    confidence: float
    method: str
    notes: list[str]


# ---------- I/O ----------


def _decode_image(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image; expected PNG or JPEG bytes.")
    return img


# ---------- chesscog (optional) ----------


def _try_chesscog(image_bgr: np.ndarray) -> RecognitionResult | None:
    try:
        from chesscog.recognition.recognition import (
            ChessRecognizer,  # type: ignore[import-not-found]
        )
    except Exception:
        return None
    try:
        recognizer = ChessRecognizer()
        rgb = cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB)
        board, _ = recognizer.predict(rgb)
        return RecognitionResult(
            fen=f"{board.board_fen()} w - - 0 1",
            confidence=0.9,
            method="chesscog",
            notes=["Recognized using chesscog CNN."],
        )
    except Exception as exc:  # pragma: no cover - depends on optional install
        logger.warning("chesscog recognition failed: %s", exc)
        return None


# ---------- Multi-set templates ----------


@dataclass
class PieceTemplate:
    """One sprite for one piece in one piece set, normalised to TEMPLATE_SIZE."""

    set_name: str
    piece_char: str            # 'P','N','B','R','Q','K','p','n','b','r','q','k'
    rgb: np.ndarray            # (S,S,3) uint8
    gray: np.ndarray           # (S,S) float32 — absolute grayscale 0..255
    alpha: np.ndarray          # (S,S) uint8 — sprite alpha mask
    mask_bin: np.ndarray       # (S,S) bool — alpha > MASK_THRESHOLD
    mask_area: int             # popcount of mask_bin
    inside_mean_lum: float     # mean grayscale inside mask
    silhouette_gray: np.ndarray  # (S,S) float32 — mean-subtracted, masked, unit-norm


SPRITE_ALPHA_THRESHOLD = 96  # alpha values above this count as foreground


def _load_sprite_rgba(path: Path) -> np.ndarray | None:
    """Load a PNG or SVG sprite and return RGBA at TEMPLATE_SIZE×TEMPLATE_SIZE."""
    if path.suffix.lower() == ".svg":
        try:
            import cairosvg
        except Exception:
            return None
        try:
            png = cairosvg.svg2png(
                bytestring=path.read_bytes(),
                output_width=TEMPLATE_SIZE,
                output_height=TEMPLATE_SIZE,
            )
        except Exception as exc:
            logger.debug("cairosvg failed for %s: %s", path, exc)
            return None
        arr = np.frombuffer(png, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    else:
        img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        return None
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    if img.shape[0] != TEMPLATE_SIZE or img.shape[1] != TEMPLATE_SIZE:
        img = cv2.resize(img, (TEMPLATE_SIZE, TEMPLATE_SIZE), interpolation=cv2.INTER_AREA)
    return img  # BGRA


def _make_piece_template(set_name: str, piece_char: str, bgra: np.ndarray) -> PieceTemplate:
    bgr = bgra[:, :, :3]
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    alpha = bgra[:, :, 3]
    mask_bin = alpha > SPRITE_ALPHA_THRESHOLD
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    if mask_bin.any():
        mean_inside = float(gray[mask_bin].mean())
        sil = (gray - mean_inside) * mask_bin
        norm = float(np.linalg.norm(sil))
        if norm > 0:
            sil = sil / norm
    else:
        mean_inside = 0.0
        sil = np.zeros_like(gray)
    return PieceTemplate(
        set_name=set_name,
        piece_char=piece_char,
        rgb=rgb,
        gray=gray,
        alpha=alpha,
        mask_bin=mask_bin,
        mask_area=int(mask_bin.sum()),
        inside_mean_lum=mean_inside,
        silhouette_gray=sil,
    )


@lru_cache(maxsize=1)
def _load_all_templates() -> list[PieceTemplate]:
    """Discover every sprite in TEMPLATES_DIR and build PieceTemplates.

    Naming convention:  ``{set_name}_{c}{P}.{ext}``
    where ``c`` is "w" or "b" and ``P`` is one of K Q R B N P (uppercase).
    """
    out: list[PieceTemplate] = []
    if not TEMPLATES_DIR.exists():
        return out
    for path in sorted(TEMPLATES_DIR.iterdir()):
        if path.suffix.lower() not in (".png", ".svg"):
            continue
        try:
            stem = path.stem  # e.g. 'chesscom-neo_wK' or 'lichess-cburnett_bN'
            set_name, piece_token = stem.rsplit("_", 1)
            color = piece_token[0]
            piece_letter = piece_token[1].upper()
            if color not in ("w", "b") or piece_letter not in ("K", "Q", "R", "B", "N", "P"):
                continue
        except ValueError:
            continue
        bgra = _load_sprite_rgba(path)
        if bgra is None:
            continue
        piece_char = piece_letter if color == "w" else piece_letter.lower()
        out.append(_make_piece_template(set_name, piece_char, bgra))
    logger.info("Loaded %d piece templates from %s", len(out), TEMPLATES_DIR)
    return out


# ---------- Square feature extraction ----------


@dataclass
class SquareCandidate:
    """A user-supplied square ready for multi-set matching."""

    rgb: np.ndarray            # (S,S,3) uint8 RGB at TEMPLATE_SIZE
    gray: np.ndarray           # (S,S) uint8
    gray_f: np.ndarray         # (S,S) float32 — for math
    mask_bin: np.ndarray       # (S,S) bool — pixels deviating from background
    mask_area: int
    coverage: float
    bg_rgb: tuple[float, float, float]
    bg_lum: float
    inside_mean_lum: float
    silhouette_gray: np.ndarray  # (S,S) float32 — mean-subtracted, masked, unit-norm


def _square_candidate(sq_bgr: np.ndarray) -> SquareCandidate:
    sq_bgr = cv2.resize(sq_bgr, (TEMPLATE_SIZE, TEMPLATE_SIZE), interpolation=cv2.INTER_AREA)
    rgb = cv2.cvtColor(sq_bgr, cv2.COLOR_BGR2RGB)
    gray = cv2.cvtColor(sq_bgr, cv2.COLOR_BGR2GRAY)
    h = TEMPLATE_SIZE
    margin = max(3, h // 12)
    corners_bgr = np.concatenate(
        [
            sq_bgr[:margin, :margin].reshape(-1, 3),
            sq_bgr[:margin, -margin:].reshape(-1, 3),
            sq_bgr[-margin:, :margin].reshape(-1, 3),
            sq_bgr[-margin:, -margin:].reshape(-1, 3),
        ]
    ).astype(np.float32)
    bg_med_bgr = tuple(float(v) for v in np.median(corners_bgr, axis=0))
    bg_rgb = (bg_med_bgr[2], bg_med_bgr[1], bg_med_bgr[0])
    bg_lum = 0.114 * bg_med_bgr[0] + 0.587 * bg_med_bgr[1] + 0.299 * bg_med_bgr[2]
    diff = np.linalg.norm(sq_bgr.astype(np.float32) - np.array(bg_med_bgr), axis=2)
    threshold = max(28.0, float(diff.max()) * 0.18)
    mask_bin = diff > threshold
    if mask_bin.sum() < (TEMPLATE_SIZE * TEMPLATE_SIZE * 0.005):
        mask_bin[:] = False
    mask_area = int(mask_bin.sum())
    coverage = mask_area / float(TEMPLATE_SIZE * TEMPLATE_SIZE)

    gf = gray.astype(np.float32)
    if mask_area > 0:
        mean_inside = float(gf[mask_bin].mean())
        sil = (gf - mean_inside) * mask_bin
        norm = float(np.linalg.norm(sil))
        if norm > 0:
            sil = sil / norm
    else:
        mean_inside = 0.0
        sil = np.zeros_like(gf)
    return SquareCandidate(
        rgb=rgb,
        gray=gray,
        gray_f=gf,
        mask_bin=mask_bin,
        mask_area=mask_area,
        coverage=coverage,
        bg_rgb=bg_rgb,
        bg_lum=float(bg_lum),
        inside_mean_lum=mean_inside,
        silhouette_gray=sil,
    )


# ---------- Board detection ----------


def _trim_uniform_border(img: np.ndarray) -> np.ndarray:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    row_std = gray.std(axis=1)
    col_std = gray.std(axis=0)
    threshold = 5.0
    rows = np.where(row_std > threshold)[0]
    cols = np.where(col_std > threshold)[0]
    if len(rows) < 8 or len(cols) < 8:
        return img
    y0, y1 = int(rows[0]), int(rows[-1]) + 1
    x0, x1 = int(cols[0]), int(cols[-1]) + 1
    return img[y0:y1, x0:x1]


def _crop_to_square(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[:2]
    if h == w:
        return img
    side = min(h, w)
    y = (h - side) // 2
    x = (w - side) // 2
    return img[y : y + side, x : x + side]


def _detect_board_by_grid(img: np.ndarray) -> tuple[int, int, int, int] | None:
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 40, 140, apertureSize=3)
    h, w = gray.shape

    def _peaks(projection: np.ndarray, axis_len: int) -> list[int] | None:
        if projection.max() == 0:
            return None
        smoothed = cv2.blur(projection.astype(np.float32).reshape(-1, 1), (5, 1)).flatten()
        thr = 0.25 * smoothed.max()
        cands: list[int] = []
        for i in range(2, len(smoothed) - 2):
            v = smoothed[i]
            if v < thr:
                continue
            if v >= smoothed[i - 1] and v >= smoothed[i + 1]:
                cands.append(int(i))
        if len(cands) < 9:
            return None
        best: tuple[float, list[int]] | None = None
        for start_i in range(min(20, len(cands))):
            start = cands[start_i]
            for end_i in range(len(cands) - 1, max(start_i, len(cands) - 21), -1):
                end = cands[end_i]
                span = end - start
                if span < axis_len * 0.4:
                    continue
                step = span / 8
                if step < 12:
                    continue
                expected = [int(round(start + step * k)) for k in range(9)]
                err = 0.0
                for ex in expected:
                    nearest = min(cands, key=lambda c: abs(c - ex))
                    err += abs(nearest - ex)
                err_norm = err / step
                if best is None or err_norm < best[0]:
                    best = (err_norm, expected)
        if best is None or best[0] > 4.0:
            return None
        return best[1]

    row_proj = edges.sum(axis=1)
    col_proj = edges.sum(axis=0)
    rows = _peaks(row_proj, h)
    cols = _peaks(col_proj, w)
    if rows is None or cols is None:
        return None
    return cols[0], rows[0], cols[-1] - cols[0], rows[-1] - rows[0]


def _detect_board(img: np.ndarray) -> np.ndarray:
    h_full, w_full = img.shape[:2]
    grid = _detect_board_by_grid(img)
    if grid is not None:
        x, y, gw, gh = grid
        # Sanity: the grid box must be mostly-square, span most of the image,
        # and not produce a crop that loses more than ~15% of either axis.
        aspect = gw / gh if gh else 0
        big_enough = gw >= 0.7 * w_full and gh >= 0.7 * h_full
        squarish = 0.92 < aspect < 1.08
        if big_enough and squarish:
            side = min(gw, gh)
            return img[y : y + side, x : x + side]

    trimmed = _trim_uniform_border(img)
    h, w = trimmed.shape[:2]
    ratio = w / h if h else 1.0
    if 0.95 < ratio < 1.05:
        return trimmed
    gray = cv2.cvtColor(trimmed, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 50, 150)
    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    best: tuple[int, tuple[int, int, int, int]] | None = None
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        r = cw / ch if ch else 0
        if r < 0.9 or r > 1.1:
            continue
        if cw < 0.5 * min(w, h):
            continue
        area = cw * ch
        if best is None or area > best[0]:
            best = (area, (x, y, cw, ch))
    if best is not None:
        x, y, cw, ch = best[1]
        side = min(cw, ch)
        return trimmed[y : y + side, x : x + side]
    return _crop_to_square(trimmed)


# ---------- Multi-set classification ----------


EMPTY_COVERAGE_THRESHOLD = 0.025  # fraction of square pixels deviating from bg


def _score_candidate(cand: SquareCandidate, tmpl: PieceTemplate) -> float:
    """Score = shape match (IoU + silhouette NCC) gated by a tone factor.
    Tone factor goes 1.0 → 0.4 as |Δinside_mean_lum| grows from 0 to ~120,
    so colour matches dominate but other shape similarities still matter.
    """
    inter = int(np.logical_and(cand.mask_bin, tmpl.mask_bin).sum())
    union = int(np.logical_or(cand.mask_bin, tmpl.mask_bin).sum())
    if union == 0:
        return 0.0
    iou = inter / union
    ncc = max(0.0, float(np.tensordot(cand.silhouette_gray, tmpl.silhouette_gray)))
    shape_score = 0.55 * iou + 0.45 * ncc

    tone_diff = abs(cand.inside_mean_lum - tmpl.inside_mean_lum)
    tone_factor = 0.4 + 0.6 * float(np.exp(-(tone_diff * tone_diff) / 2500.0))

    return shape_score * tone_factor


def _multi_set_recognize(image: np.ndarray) -> RecognitionResult | None:
    templates = _load_all_templates()
    if not templates:
        return None

    # group by set
    sets: dict[str, list[PieceTemplate]] = {}
    for t in templates:
        sets.setdefault(t.set_name, []).append(t)

    board_img = _detect_board(image)
    h, w = board_img.shape[:2]
    sq_h = h / 8
    sq_w = w / 8

    candidates: list[list[SquareCandidate]] = []
    occupancy: list[list[bool]] = []
    for r in range(8):
        row_cands: list[SquareCandidate] = []
        row_occ: list[bool] = []
        for c in range(8):
            sx = int(c * sq_w)
            sy = int(r * sq_h)
            ex = int((c + 1) * sq_w)
            ey = int((r + 1) * sq_h)
            sq = board_img[sy:ey, sx:ex]
            cand = _square_candidate(sq)
            row_cands.append(cand)
            row_occ.append(cand.coverage >= EMPTY_COVERAGE_THRESHOLD)
        candidates.append(row_cands)
        occupancy.append(row_occ)

    # Pick the best set first: for each occupied square, score against each
    # set's best piece template and aggregate.
    set_scores: dict[str, float] = {name: 0.0 for name in sets}
    occupied_count = 0
    for r in range(8):
        for c in range(8):
            if not occupancy[r][c]:
                continue
            occupied_count += 1
            cand = candidates[r][c]
            for name, tmpls in sets.items():
                best = max((_score_candidate(cand, t) for t in tmpls), default=0.0)
                set_scores[name] += best
    if occupied_count == 0:
        return RecognitionResult(
            fen="8/8/8/8/8/8/8/8 w - - 0 1",
            confidence=0.5,
            method="multi-set",
            notes=["Доска пустая или фигуры не различимы."],
        )

    best_set_name = max(set_scores.items(), key=lambda kv: kv[1])[0]
    best_set_tmpls = sets[best_set_name]
    avg_set_score = set_scores[best_set_name] / occupied_count

    # Now classify each square using only the winning set.
    rows: list[str] = []
    confidences: list[float] = []
    for r in range(8):
        chars: list[str] = []
        for c in range(8):
            cand = candidates[r][c]
            if not occupancy[r][c]:
                chars.append(".")
                confidences.append(1.0 - cand.coverage)
                continue
            best_score = -1.0
            best_piece = "."
            for tmpl in best_set_tmpls:
                s = _score_candidate(cand, tmpl)
                if s > best_score:
                    best_score = s
                    best_piece = tmpl.piece_char
            if best_score < 0.20:
                chars.append(".")
                confidences.append(0.4)
            else:
                chars.append(best_piece)
                confidences.append(best_score)
        compressed = ""
        empties = 0
        for ch in chars:
            if ch == ".":
                empties += 1
                continue
            if empties:
                compressed += str(empties)
                empties = 0
            compressed += ch
        if empties:
            compressed += str(empties)
        rows.append(compressed)

    fen = f"{'/'.join(rows)} w - - 0 1"
    avg_conf = float(np.mean(confidences)) if confidences else 0.0
    pretty_set = best_set_name.replace("chesscom-", "chess.com ").replace(
        "lichess-", "lichess "
    )
    notes = [
        f"Распознан набор фигур: {pretty_set} (агрегатный score {avg_set_score:.2f}).",
        f"Загружено наборов: {len(sets)} (chess.com Neo/Wood/Classic и др., "
        f"lichess Cburnett/Merida/Alpha и др.).",
        "Сторона хода и права на рокировку — недоступны из картинки и выставлены "
        "по умолчанию (белые, без прав). Поправь вручную.",
    ]
    return RecognitionResult(fen=fen, confidence=avg_conf, method="multi-set", notes=notes)


# ---------- Legacy single-set fallback (kept for safety) ----------


def _occupancy_only_fallback(image: np.ndarray, notes: list[str]) -> RecognitionResult:
    board_img = _detect_board(image)
    h, w = board_img.shape[:2]
    rows: list[str] = []
    sq_h = h / 8
    sq_w = w / 8
    for r in range(8):
        chars: list[str] = []
        for c in range(8):
            square = board_img[
                int(r * sq_h) : int((r + 1) * sq_h),
                int(c * sq_w) : int((c + 1) * sq_w),
            ]
            cand = _square_candidate(square)
            chars.append("." if cand.coverage < EMPTY_COVERAGE_THRESHOLD else "P")
        compressed = ""
        empties = 0
        for ch in chars:
            if ch == ".":
                empties += 1
                continue
            if empties:
                compressed += str(empties)
                empties = 0
            compressed += ch
        if empties:
            compressed += str(empties)
        rows.append(compressed)
    return RecognitionResult(
        fen=f"{'/'.join(rows)} w - - 0 1",
        confidence=0.5,
        method="occupancy-only",
        notes=notes,
    )


# ---------- Public pipeline ----------


def recognize(image_bytes: bytes) -> RecognitionResult:
    image = _decode_image(image_bytes)
    cc = _try_chesscog(image)
    if cc is not None:
        return cc
    multi = _multi_set_recognize(image)
    if multi is not None:
        return multi
    return _occupancy_only_fallback(
        image,
        ["Templates directory missing or empty; only occupancy is detected."],
    )


def diagnostics() -> dict[str, Any]:
    info: dict[str, Any] = {
        "chesscog_available": False,
        "torch_available": False,
        "templates_available": False,
        "templates_count": 0,
        "templates_sets": 0,
    }
    try:
        import torch  # type: ignore[import-not-found]  # noqa: F401

        info["torch_available"] = True
    except Exception:
        pass
    try:
        import chesscog  # type: ignore[import-not-found]  # noqa: F401

        info["chesscog_available"] = True
    except Exception:
        pass
    tmpls = _load_all_templates()
    info["templates_count"] = len(tmpls)
    info["templates_sets"] = len({t.set_name for t in tmpls})
    info["templates_available"] = len(tmpls) > 0
    return info


__all__ = ["recognize", "diagnostics", "RecognitionResult"]
