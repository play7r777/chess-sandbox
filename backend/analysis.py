"""Game-import + chess.com-style move-by-move analysis.

This module exposes:

- `import_game(source)` — fetch a PGN given either a chess.com / lichess URL
  or a raw PGN string. Returns a parsed game with metadata + UCI move list.
- `analyse_game(...)` — run Stockfish on each ply, classify each move
  (Brilliant / Great / Best / Excellent / Good / Book / Inaccuracy / Mistake /
  Blunder / Miss) and return per-side accuracy + ACPL.

The classification rules try to mirror chess.com's review:

- Best / Excellent / Good / Inaccuracy / Mistake / Blunder are picked from
  centipawn loss (CPL) thresholds.
- Book — within the first ~10 plies AND CPL <= 30.
- Miss — before the move the side had a clear winning advantage (>= +3 cp
  or mate), and after the played move the advantage shrinks below +1.
- Brilliant — best (or near-best) AND the moved piece is left attacked by
  a strictly less-valuable piece (heuristic sacrifice) AND the position
  still favours the side to move.
- Great — only-move (every other top-level alternative loses >= 200 cp
  vs. the played move) OR turns a losing position into a winning one.
"""
from __future__ import annotations

import asyncio
import io
import math
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import chess
import chess.pgn
import requests  # type: ignore[import-untyped]

from .stockfish_engine import engine

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0 Safari/537.36 chess-sandbox/0.1"
)

PIECE_VALUES: dict[chess.PieceType, int] = {
    chess.PAWN: 100,
    chess.KNIGHT: 320,
    chess.BISHOP: 330,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 100000,
}

# Mate scores compressed into a centipawn-equivalent number so we can do
# arithmetic without splitting cp / mate everywhere.
MATE_SCORE = 100_000


@dataclass
class ImportedGame:
    pgn: str
    headers: dict[str, str]
    moves_uci: list[str]
    starting_fen: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "pgn": self.pgn,
            "headers": self.headers,
            "moves_uci": self.moves_uci,
            "starting_fen": self.starting_fen,
        }


@dataclass
class MoveAnalysis:
    ply: int
    side: str          # "w" or "b"
    move_uci: str
    move_san: str
    fen_before: str
    fen_after: str
    eval_before_cp: int   # in centipawns, from mover's POV; mate => +/- MATE_SCORE
    eval_after_cp: int    # in centipawns, from mover's POV
    best_move_uci: str | None
    best_move_san: str | None
    cpl: int              # centipawn loss for the played move
    classification: str   # one of CLASS_LABELS
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "ply": self.ply,
            "side": self.side,
            "move_uci": self.move_uci,
            "move_san": self.move_san,
            "fen_before": self.fen_before,
            "fen_after": self.fen_after,
            "eval_before_cp": self.eval_before_cp,
            "eval_after_cp": self.eval_after_cp,
            "best_move_uci": self.best_move_uci,
            "best_move_san": self.best_move_san,
            "cpl": self.cpl,
            "classification": self.classification,
            "note": self.note,
        }


CLASS_LABELS = [
    "brilliant",
    "great",
    "best",
    "excellent",
    "good",
    "book",
    "inaccuracy",
    "mistake",
    "blunder",
    "miss",
]


# ---------------------------------------------------------------------------
# Game import
# ---------------------------------------------------------------------------


def _looks_like_pgn(text: str) -> bool:
    return bool(re.search(r"^\s*\[[A-Za-z]+\s+\"", text, re.MULTILINE)) or bool(
        re.search(r"\b1\.\s*[A-Za-z]", text)
    )


def import_game(source: str) -> ImportedGame:
    """Resolve a URL or raw PGN to a parsed `ImportedGame`."""
    source = (source or "").strip()
    if not source:
        raise ValueError("Empty source")
    if _looks_like_pgn(source):
        return _parse_pgn(source)
    url = urlparse(source)
    if url.netloc.endswith("lichess.org"):
        return _fetch_lichess(source)
    if url.netloc.endswith("chess.com"):
        return _fetch_chesscom(source)
    raise ValueError(
        "Unknown source — paste a PGN, or use a chess.com / lichess.org game URL."
    )


def _fetch_lichess(url: str) -> ImportedGame:
    m = re.search(r"lichess\.org/(?:embed/)?(\w{8})", url)
    if not m:
        raise ValueError("Could not extract lichess game id from URL.")
    game_id = m.group(1)
    r = requests.get(
        f"https://lichess.org/game/export/{game_id}.pgn",
        headers={"User-Agent": USER_AGENT, "Accept": "application/x-chess-pgn"},
        timeout=15,
    )
    if r.status_code != 200:
        raise ValueError(f"Lichess returned HTTP {r.status_code}.")
    return _parse_pgn(r.text)


def _fetch_chesscom(url: str) -> ImportedGame:
    m = re.search(r"chess\.com/game/(live|daily)/(\d+)", url)
    if not m:
        raise ValueError(
            "chess.com URL must look like https://www.chess.com/game/live/<id>"
        )
    kind, game_id = m.group(1), m.group(2)
    cb = requests.get(
        f"https://www.chess.com/callback/{kind}/game/{game_id}",
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        timeout=15,
    )
    if cb.status_code != 200:
        raise ValueError(f"chess.com callback returned HTTP {cb.status_code}.")
    payload = cb.json().get("game") or {}
    headers = payload.get("pgnHeaders") or {}
    white = headers.get("White") or ""
    date = headers.get("Date") or ""
    yyyy_mm = re.match(r"(\d{4})\.(\d{2})", date)
    if not (white and yyyy_mm):
        raise ValueError("chess.com payload missing White/Date — cannot locate PGN.")
    yyyy, mm = yyyy_mm.group(1), yyyy_mm.group(2)
    archive = requests.get(
        f"https://api.chess.com/pub/player/{white.lower()}/games/{yyyy}/{mm}",
        headers={"User-Agent": USER_AGENT},
        timeout=20,
    )
    if archive.status_code != 200:
        raise ValueError(f"chess.com archive returned HTTP {archive.status_code}.")
    games = archive.json().get("games") or []
    for g in games:
        if str(game_id) in (g.get("url") or "") and g.get("pgn"):
            return _parse_pgn(g["pgn"])
    # Fallback: try opponent's archive (some games only appear under one side).
    black = headers.get("Black") or ""
    if black:
        archive_b = requests.get(
            f"https://api.chess.com/pub/player/{black.lower()}/games/{yyyy}/{mm}",
            headers={"User-Agent": USER_AGENT},
            timeout=20,
        )
        if archive_b.status_code == 200:
            for g in archive_b.json().get("games") or []:
                if str(game_id) in (g.get("url") or "") and g.get("pgn"):
                    return _parse_pgn(g["pgn"])
    raise ValueError(
        "Could not locate this chess.com game in the public archives. "
        "It may be too recent (~24h delay) or a private/unlisted game."
    )


def _parse_pgn(pgn_text: str) -> ImportedGame:
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        raise ValueError("PGN is empty or could not be parsed.")
    headers = {k: v for k, v in game.headers.items()}
    starting_fen = headers.get("FEN", chess.STARTING_FEN)
    board = game.board()
    moves_uci: list[str] = []
    for move in game.mainline_moves():
        moves_uci.append(move.uci())
        board.push(move)
    return ImportedGame(
        pgn=pgn_text.strip(),
        headers=headers,
        moves_uci=moves_uci,
        starting_fen=starting_fen,
    )


# ---------------------------------------------------------------------------
# Engine score helpers
# ---------------------------------------------------------------------------


def _score_to_cp(info: dict[str, Any], pov_color: chess.Color) -> int:
    """Convert a python-chess score dict to a CP value (mate => +/- MATE_SCORE)."""
    score = info.get("score")
    if score is None:
        return 0
    pov = score.white() if pov_color == chess.WHITE else score.black()
    if pov.is_mate():
        mate_in = pov.mate() or 0
        if mate_in > 0:
            return MATE_SCORE - mate_in  # mate-in-1 is best => largest cp
        if mate_in < 0:
            return -MATE_SCORE - mate_in
        # mate==0: side to move is already mated
        return -MATE_SCORE
    cp = pov.score(mate_score=MATE_SCORE)
    return int(cp) if cp is not None else 0


def _is_winning(cp: int) -> bool:
    return cp >= 300


def _is_losing(cp: int) -> bool:
    return cp <= -300


def _is_decisive_advantage(cp: int) -> bool:
    return cp >= 500 or cp >= MATE_SCORE - 1000


# ---------------------------------------------------------------------------
# Sacrifice detection (heuristic for Brilliant)
# ---------------------------------------------------------------------------


def _piece_value(piece: chess.Piece | None) -> int:
    return PIECE_VALUES.get(piece.piece_type, 0) if piece else 0


def _is_sacrifice(board_before: chess.Board, move: chess.Move) -> bool:
    """Return True if the played move appears to sacrifice material.

    Heuristic: after applying the move, the moving piece sits on a square
    attacked by an opponent piece of strictly lower value (a 'lower-value
    attacker' picks it off for free or for unfavourable trade). This is a
    loose but cheap proxy for chess.com's brilliancy criterion.
    """
    moving_piece = board_before.piece_at(move.from_square)
    if moving_piece is None or moving_piece.piece_type == chess.PAWN:
        return False
    captured_value = _piece_value(board_before.piece_at(move.to_square))
    moved_value = _piece_value(moving_piece)
    # If we capture a piece of equal-or-greater value it's not a sacrifice.
    if captured_value >= moved_value:
        return False
    after = board_before.copy(stack=False)
    after.push(move)
    attackers = after.attackers(not moving_piece.color, move.to_square)
    if not attackers:
        return False
    defenders = after.attackers(moving_piece.color, move.to_square)
    min_attacker_value = min(
        _piece_value(after.piece_at(sq)) for sq in attackers
    )
    # Even with defenders we treat it as a sacrifice if the piece is attacked
    # by something cheaper than itself — recapture sequence will cost us
    # material (the cheaper attacker wins).
    if min_attacker_value < moved_value and not defenders:
        return True
    if defenders and min_attacker_value < moved_value:
        # Loose: opponent can choose to take with the cheaper piece.
        return True
    return False


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def _classify(
    *,
    ply_index: int,
    cpl: int,
    eval_before_cp: int,
    eval_after_cp: int,
    is_top1: bool,
    only_move_gap_cp: int,
    is_sacrifice: bool,
) -> tuple[str, str]:
    """Pick a label + short note for one move."""
    # Book: very early in the game and the move is essentially perfect.
    # We don't have an opening DB, so this is a heuristic — limit to first
    # few full moves and very small CPL so non-theoretical moves still get a
    # proper Best/Excellent/etc. label.
    if ply_index < 10 and cpl <= 10 and is_top1:
        return "book", "Теория"

    # Miss: was clearly winning, now isn't.
    if eval_before_cp >= 300 and eval_after_cp < 100 and cpl >= 100:
        return "miss", f"Упущена победа ({_pretty_cp(eval_before_cp)} → {_pretty_cp(eval_after_cp)})"
    # Mate-miss
    if eval_before_cp >= MATE_SCORE - 1000 and eval_after_cp < MATE_SCORE - 1000:
        return "miss", "Упущен мат"

    if is_top1 and is_sacrifice and eval_after_cp >= 100:
        return "brilliant", "Бриллиантовый ход — жертва, остаётся выигрышной позиция"

    # Great: only-move OR turning a losing position into a winning one.
    if is_top1 and only_move_gap_cp >= 200:
        return "great", "Великолепный ход — единственный спасительный"
    if eval_before_cp <= -200 and eval_after_cp >= 100:
        return "great", "Великолепный ход — переломил позицию"

    if is_top1:
        return "best", "Лучший ход"
    if cpl <= 20:
        return "excellent", "Превосходный"
    if cpl <= 50:
        return "good", "Хороший"
    if cpl <= 100:
        return "inaccuracy", f"Неточность (−{cpl} cp)"
    if cpl <= 200:
        return "mistake", f"Ошибка (−{cpl} cp)"
    return "blunder", f"Грубая ошибка (−{cpl} cp)"


def _pretty_cp(cp: int) -> str:
    if cp >= MATE_SCORE - 1000:
        return f"#+{MATE_SCORE - cp}"
    if cp <= -MATE_SCORE + 1000:
        return f"#-{cp + MATE_SCORE}"
    return ("+" if cp > 0 else "") + f"{cp / 100:.2f}"


# ---------------------------------------------------------------------------
# Accuracy (chess.com-style win-percentage method)
# ---------------------------------------------------------------------------


def _winning_chances(cp: int) -> float:
    """Map cp to a 0..1 win expectancy for the side whose POV the cp is in."""
    if cp >= MATE_SCORE - 1000:
        return 1.0
    if cp <= -MATE_SCORE + 1000:
        return 0.0
    # 50% + 50% * (2 / (1 + e^(-0.00368208 * cp)) - 1) — Lichess formula.
    return 0.5 + 0.5 * (2.0 / (1.0 + math.exp(-0.00368208 * cp)) - 1.0)


def _accuracy_for_pair(wp_before: float, wp_after: float) -> float:
    """Lichess-style per-move accuracy 0..100."""
    delta = max(0.0, wp_before - wp_after)
    raw = 103.1668 * math.exp(-0.04354 * (delta * 100.0)) - 3.1669
    return float(max(0.0, min(100.0, raw)))


# ---------------------------------------------------------------------------
# Main analysis loop
# ---------------------------------------------------------------------------


async def analyse_game(
    moves_uci: list[str],
    starting_fen: str = chess.STARTING_FEN,
    movetime_ms: int = 250,
    multipv: int = 2,
    progress_cb: Any = None,
) -> dict[str, Any]:
    """Walk the game, run Stockfish per ply, classify each move."""
    if not engine.is_running:
        raise RuntimeError(
            "Stockfish is not configured. Start the engine first via the UI."
        )
    board = chess.Board(starting_fen)
    analyses: list[MoveAnalysis] = []
    accuracies: dict[chess.Color, list[float]] = {chess.WHITE: [], chess.BLACK: []}
    cpls: dict[chess.Color, list[int]] = {chess.WHITE: [], chess.BLACK: []}
    counts: dict[str, int] = {label: 0 for label in CLASS_LABELS}

    for ply_index, uci in enumerate(moves_uci):
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            move = None
        if move is None or move not in board.legal_moves:
            # Truncate analysis at first illegal move; better than crashing.
            break

        side_color = board.turn
        side = "w" if side_color == chess.WHITE else "b"
        pre_board = board.copy(stack=False)
        fen_before = pre_board.fen()
        san = pre_board.san(move)
        is_sac = _is_sacrifice(pre_board, move)

        infos_before = await engine.analyse_raw(
            fen_before, movetime_ms=movetime_ms, multipv=multipv
        )
        if not infos_before:
            break
        eval_before_cp = _score_to_cp(infos_before[0], side_color)
        best_pv = infos_before[0].get("pv") or []
        best_move = best_pv[0] if best_pv else None
        is_top1 = best_move is not None and move == best_move

        only_move_gap_cp = 0
        if len(infos_before) >= 2:
            top1 = _score_to_cp(infos_before[0], side_color)
            top2 = _score_to_cp(infos_before[1], side_color)
            only_move_gap_cp = max(0, top1 - top2)

        # Eval after the played move: analyse the resulting position with
        # multipv=1 (cheaper) and flip POV back to the mover.
        board.push(move)
        infos_after = await engine.analyse_raw(
            board.fen(), movetime_ms=movetime_ms, multipv=1
        )
        eval_after_cp = (
            _score_to_cp(infos_after[0], side_color)
            if infos_after
            else eval_before_cp
        )

        cpl = max(0, eval_before_cp - eval_after_cp)

        label, note = _classify(
            ply_index=ply_index,
            cpl=cpl,
            eval_before_cp=eval_before_cp,
            eval_after_cp=eval_after_cp,
            is_top1=is_top1,
            only_move_gap_cp=only_move_gap_cp,
            is_sacrifice=is_sac,
        )
        counts[label] = counts.get(label, 0) + 1

        wp_before = _winning_chances(eval_before_cp)
        wp_after = _winning_chances(eval_after_cp)
        accuracies[side_color].append(_accuracy_for_pair(wp_before, wp_after))
        cpls[side_color].append(cpl)

        best_san = None
        if best_move is not None:
            best_san = pre_board.san(best_move)

        analyses.append(
            MoveAnalysis(
                ply=ply_index + 1,
                side=side,
                move_uci=uci,
                move_san=san,
                fen_before=fen_before,
                fen_after=board.fen(),
                eval_before_cp=eval_before_cp,
                eval_after_cp=eval_after_cp,
                best_move_uci=best_move.uci() if best_move else None,
                best_move_san=best_san,
                cpl=cpl,
                classification=label,
                note=note,
            )
        )

        if progress_cb is not None:
            await progress_cb(ply_index + 1, len(moves_uci))

    def _avg(xs: list[float] | list[int]) -> float:
        return float(sum(xs) / len(xs)) if xs else 0.0

    summary = {
        "white": {
            "accuracy": round(_avg(accuracies[chess.WHITE]), 1),
            "acpl": round(_avg(cpls[chess.WHITE]), 1),
            "moves": len(cpls[chess.WHITE]),
        },
        "black": {
            "accuracy": round(_avg(accuracies[chess.BLACK]), 1),
            "acpl": round(_avg(cpls[chess.BLACK]), 1),
            "moves": len(cpls[chess.BLACK]),
        },
        "counts": counts,
    }

    return {
        "moves": [m.to_dict() for m in analyses],
        "summary": summary,
    }


# Helper: import_game from a thread (it does HTTP).
async def import_game_async(source: str) -> ImportedGame:
    return await asyncio.to_thread(import_game, source)
