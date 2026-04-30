"""Position recognition from a screenshot.

We support two modes, picked automatically:

1. **chesscog** — if a local install of `chesscog` and its trained weights are
   available we delegate to it. This is the most accurate path and is designed
   for arbitrary chessboard photos. Optional install: ``pip install
   "chess-sandbox[recognize]"`` plus the chesscog package itself.

2. **Template-match (default)** — a self-contained pipeline that:
     a. detects the chessboard bounding box in the input image,
     b. splits it into 64 squares,
     c. compares each square against pre-rendered piece templates (generated
        once with `python-chess`'s SVG piece set, which is the well-known
        Cburnett set used by lichess and many other sites).

   Template matching uses normalized cross-correlation on the foreground
   silhouette of each square, which makes it robust to slight colour /
   contrast differences between the input image and our reference renders.
   Accuracy is best for clean digital screenshots; messy photos benefit from
   installing `chesscog`.

In both modes we return a fully-formed FEN. Side-to-move and castling rights
are not derivable from the picture alone — they default to "white to move,
no rights" and the user can correct them in the UI.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache
from typing import Any

import cv2
import numpy as np

logger = logging.getLogger(__name__)

PIECE_FEN_CHARS: tuple[str, ...] = ("P", "N", "B", "R", "Q", "K", "p", "n", "b", "r", "q", "k")
TEMPLATE_SIZE = 64  # pixels per side; templates are square


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


# ---------- Template generation ----------


def _render_reference_board() -> np.ndarray | None:
    """Render a known starting position with python-chess + cairosvg.

    The resulting image (512x512) gives us 32 square renderings: 16 pieces on
    rank 1, 2, 7, 8 against light and dark squares. We use this as the ground
    truth template set.
    """
    try:
        import cairosvg
        import chess
        import chess.svg
    except Exception as exc:  # pragma: no cover - optional dep at runtime
        logger.info("Cannot generate reference templates (cairosvg missing): %s", exc)
        return None
    board = chess.Board()
    svg = chess.svg.board(board, size=TEMPLATE_SIZE * 8, coordinates=False)
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=TEMPLATE_SIZE * 8)
    arr = np.frombuffer(png, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    return img


PIECE_TYPES_NEUTRAL: tuple[str, ...] = ("k", "q", "r", "b", "n", "p")


def _render_board(fen: str) -> np.ndarray | None:
    try:
        import cairosvg
        import chess
        import chess.svg
    except Exception as exc:  # pragma: no cover - optional dep at runtime
        logger.info("Cannot render reference board: %s", exc)
        return None
    board = chess.Board(fen)
    svg = chess.svg.board(board, size=TEMPLATE_SIZE * 8, coordinates=False)
    png = cairosvg.svg2png(bytestring=svg.encode(), output_width=TEMPLATE_SIZE * 8)
    arr = np.frombuffer(png, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


@lru_cache(maxsize=1)
def _piece_templates() -> dict[str, list[np.ndarray]] | None:
    """Build {piece_char: [grayscale templates]}.

    We render two reference boards. The first is the standard starting
    position; the second swaps the king and queen onto the *other* square
    colour so every piece × square-colour combination is captured. Each
    template is the grayscale render of the square, normalised to zero
    mean and unit variance. Matching is done by ``cv2.matchTemplate`` with
    ``TM_CCORR_NORMED`` which is invariant to overall brightness scaling
    but still distinguishes white from black pieces.
    """
    boards: list[tuple[np.ndarray, dict[int, list[str]]]] = []
    # Board 1: starting position
    ref1 = _render_board("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w - - 0 1")
    if ref1 is None:
        return None
    boards.append((ref1, {
        0: ["r", "n", "b", "q", "k", "b", "n", "r"],
        1: ["p"] * 8,
        6: ["P"] * 8,
        7: ["R", "N", "B", "Q", "K", "B", "N", "R"],
    }))
    # Board 2: queens and kings swapped so they appear on the missing
    # square colours. d/e files get swapped: white K to d1 (light),
    # white Q to e1 (dark); same for black on rank 8.
    ref2 = _render_board("rnbkqbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBKQBNR w - - 0 1")
    if ref2 is not None:
        boards.append((ref2, {
            0: ["r", "n", "b", "k", "q", "b", "n", "r"],
            7: ["R", "N", "B", "K", "Q", "B", "N", "R"],
        }))
    templates: dict[str, list[np.ndarray]] = {p: [] for p in PIECE_FEN_CHARS}
    for ref, rows in boards:
        h = ref.shape[0]
        sq = h // 8
        for r, pieces in rows.items():
            for c, piece in enumerate(pieces):
                sq_img = ref[r * sq : (r + 1) * sq, c * sq : (c + 1) * sq]
                sq_img = cv2.resize(sq_img, (TEMPLATE_SIZE, TEMPLATE_SIZE))
                gray = cv2.cvtColor(sq_img, cv2.COLOR_BGR2GRAY).astype(np.float32)
                gray -= gray.mean()
                norm = float(np.linalg.norm(gray))
                if norm > 0:
                    gray /= norm
                templates[piece].append(gray)
    return templates


@dataclass
class SquareFeatures:
    """Compact representation of a square for template matching."""

    normalized: np.ndarray      # grayscale, mean-subtracted, unit-norm
    coverage: float             # fraction of square pixels far from background
    bg_intensity: float         # background grayscale intensity (0..255)


def _square_to_features(sq_bgr: np.ndarray) -> SquareFeatures:
    """Resize the square, normalise it for template matching and report
    a coverage estimate so we can short-circuit empty squares cheaply.
    """
    sq = cv2.resize(sq_bgr, (TEMPLATE_SIZE, TEMPLATE_SIZE))
    gray = cv2.cvtColor(sq, cv2.COLOR_BGR2GRAY).astype(np.float32)
    h, _w = gray.shape
    margin = max(2, h // 12)
    corners = np.concatenate(
        [
            gray[:margin, :margin].flatten(),
            gray[:margin, -margin:].flatten(),
            gray[-margin:, :margin].flatten(),
            gray[-margin:, -margin:].flatten(),
        ]
    )
    bg_med = float(np.median(corners))
    coverage = float((np.abs(gray - bg_med) > 25.0).mean())

    norm_img = gray - gray.mean()
    norm = float(np.linalg.norm(norm_img))
    if norm > 0:
        norm_img = norm_img / norm
    return SquareFeatures(
        normalized=norm_img,
        coverage=coverage,
        bg_intensity=bg_med,
    )


# ---------- Board detection ----------


def _trim_uniform_border(img: np.ndarray) -> np.ndarray:
    """Crop solid-colour borders by detecting rows/columns with low variance."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    row_std = gray.std(axis=1)
    col_std = gray.std(axis=0)
    threshold = 5.0  # very smooth = uniform border
    rows = np.where(row_std > threshold)[0]
    cols = np.where(col_std > threshold)[0]
    if len(rows) < 8 or len(cols) < 8:
        return img
    y0, y1 = int(rows[0]), int(rows[-1]) + 1
    x0, x1 = int(cols[0]), int(cols[-1]) + 1
    return img[y0:y1, x0:x1]


def _crop_to_square(img: np.ndarray) -> np.ndarray:
    """Centre-crop the image to a square aspect ratio."""
    h, w = img.shape[:2]
    if h == w:
        return img
    side = min(h, w)
    y = (h - side) // 2
    x = (w - side) // 2
    return img[y : y + side, x : x + side]


def _detect_board_by_grid(img: np.ndarray) -> tuple[int, int, int, int] | None:
    """Locate the chessboard by finding 9 evenly spaced lines in each axis.

    A chessboard produces 9 strong horizontal and 9 strong vertical lines
    (the borders + 7 internal dividers). We use Canny + Hough to detect line
    segments, project them onto each axis, and look for the densest cluster
    of 9 roughly-equispaced peaks. Returns (x, y, w, h) of the bounding box.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 40, 140, apertureSize=3)
    h, w = gray.shape

    def _peaks(projection: np.ndarray, axis_len: int) -> list[int] | None:
        # Smooth and pick local maxima above a fraction of the global max.
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
        # Try to pick 9 peaks that are roughly evenly spaced.
        # We iterate over candidate spacings and starting positions.
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
    """Best-effort detection of the chessboard region.

    Strategy:
      1. Try to detect the 9-line grid directly (most accurate, even when
         coordinate labels surround the board).
      2. Otherwise, trim solid borders and look for the largest square-ish
         contour.
      3. Fall back to a centre square crop.
    """
    grid = _detect_board_by_grid(img)
    if grid is not None:
        x, y, gw, gh = grid
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


# ---------- Classification ----------


EMPTY_COVERAGE_THRESHOLD = 0.05  # below this fraction we treat a square as empty
WEAK_MATCH_THRESHOLD = 0.30  # template score below which we don't trust the match


def _classify_square(
    features: SquareFeatures,
    templates: dict[str, list[np.ndarray]],
) -> tuple[str, float]:
    """Classify a single square as empty or one of 12 pieces.

    Pipeline:
    1. If the square has very little contrast against its corners, declare
       it empty without running template matching.
    2. Otherwise correlate the normalised square against every template
       (12 pieces × 1+ samples per piece). The best score wins, but only
       if it clears ``WEAK_MATCH_THRESHOLD`` — a clean piece in cburnett
       or a similar style scores well above it.
    """
    if features.coverage < EMPTY_COVERAGE_THRESHOLD:
        return ".", 1.0 - features.coverage
    best_piece = "."
    best_score = -1.0
    sq = features.normalized
    for piece, mats in templates.items():
        for tmpl in mats:
            score = float(np.tensordot(sq, tmpl))
            if score > best_score:
                best_score = score
                best_piece = piece
    if best_score < WEAK_MATCH_THRESHOLD or best_piece == ".":
        return ".", 1.0 - features.coverage
    return best_piece, best_score


# ---------- Public pipeline ----------


def _template_recognize(image: np.ndarray) -> RecognitionResult:
    templates = _piece_templates()
    if templates is None:
        notes = [
            "Could not initialize reference templates (cairosvg unavailable).",
            "Falling back to occupancy-only detection.",
        ]
        return _occupancy_only_fallback(image, notes)

    board_img = _detect_board(image)
    h, w = board_img.shape[:2]
    sq_h = h / 8
    sq_w = w / 8

    rows: list[str] = []
    confidences: list[float] = []
    for r in range(8):
        chars: list[str] = []
        for c in range(8):
            sx = int(c * sq_w)
            sy = int(r * sq_h)
            ex = int((c + 1) * sq_w)
            ey = int((r + 1) * sq_h)
            square = board_img[sy:ey, sx:ex]
            features = _square_to_features(square)
            piece, conf = _classify_square(features, templates)
            confidences.append(conf)
            chars.append(piece)
        # Compress empty runs per FEN.
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
    notes = [
        "Использованы шаблоны набора Cburnett (lichess / python-chess).",
        "Лучше всего работает для чистых цифровых скриншотов; с фотографий доски точность ниже.",
        "Сторона хода и права на рокировку — недоступны из картинки и выставлены по умолчанию (белые, без прав). Поправь вручную.",
    ]
    return RecognitionResult(fen=fen, confidence=avg_conf, method="template", notes=notes)


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
            features = _square_to_features(square)
            empty = features.coverage < EMPTY_COVERAGE_THRESHOLD
            chars.append("." if empty else "P")
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


def recognize(image_bytes: bytes) -> RecognitionResult:
    """Top-level entry point: bytes → RecognitionResult."""
    image = _decode_image(image_bytes)
    cc = _try_chesscog(image)
    if cc is not None:
        return cc
    return _template_recognize(image)


def diagnostics() -> dict[str, Any]:
    info: dict[str, Any] = {
        "chesscog_available": False,
        "torch_available": False,
        "templates_available": False,
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
    try:
        import cairosvg  # type: ignore[import-not-found]  # noqa: F401

        info["templates_available"] = True
    except Exception:
        pass
    return info


__all__ = ["recognize", "diagnostics", "RecognitionResult"]
