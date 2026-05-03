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

from .opening_book import is_book_position, masters_in_book
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
    coach: list[str] | None = None  # additional Russian "coach" hints
    best_pv_uci: list[str] | None = None  # engine's top-line continuation
    best_pv_san: list[str] | None = None  # same, in SAN from pre_board

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
            "coach": self.coach or [],
            "best_pv_uci": self.best_pv_uci or [],
            "best_pv_san": self.best_pv_san or [],
        }


CLASS_LABELS = [
    "brilliant",
    "great",
    "best",
    "excellent",
    "good",
    "book",
    "forced",
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


def _see(board: chess.Board, square: chess.Square, side: chess.Color) -> int:
    """Static Exchange Evaluation.

    Returns the material gain/loss in centipawns for `side` if it
    initiates a capture sequence on `square` (or zero if it can't or
    shouldn't). Considers the cheapest attacker first and recursively
    evaluates the recapture chain; a side that would lose material on
    its turn declines the capture.
    """
    target = board.piece_at(square)
    if target is None:
        return 0
    attackers = list(board.attackers(side, square))
    if not attackers:
        return 0
    # Pick the cheapest attacker.
    cheapest = min(attackers, key=lambda s: _piece_value(board.piece_at(s)))
    # Make the capture; recurse for the opponent's reply.
    sub_board = board.copy(stack=False)
    captured_value = _piece_value(target)
    sub_board.remove_piece_at(square)
    moving_piece = sub_board.piece_at(cheapest)
    sub_board.remove_piece_at(cheapest)
    if moving_piece is not None:
        sub_board.set_piece_at(square, moving_piece)
    # Opponent's gain if they continue:
    opp_gain = _see(sub_board, square, not side)
    # Choose max(0, gain) — side won't capture if it loses material.
    return max(0, captured_value - opp_gain)


def _is_sacrifice(board_before: chess.Board, move: chess.Move) -> bool:
    """Return True if the played move sacrifices material.

    Uses static-exchange evaluation (SEE) on the destination square
    after the move is played: if the opponent can win material from
    the to-square via a capture sequence (and the move wasn't a
    simple equal-or-better trade), it counts as a sacrifice.
    """
    moving_piece = board_before.piece_at(move.from_square)
    if moving_piece is None or moving_piece.piece_type == chess.PAWN:
        return False
    moved_value = _piece_value(moving_piece)
    captured_value = _piece_value(board_before.piece_at(move.to_square))
    # If we capture a piece of equal-or-greater value the trade isn't a sac.
    if captured_value >= moved_value:
        return False
    after = board_before.copy(stack=False)
    after.push(move)
    # SEE on the destination square: how much can the opponent win there?
    opp_gain = _see(after, move.to_square, not moving_piece.color)
    # Material lost = piece we placed minus what we already captured
    # (pawn promotion/etc. ignored — close enough).
    net_loss = opp_gain - captured_value
    # Require a meaningful loss (≥ 200 cp ≈ minor piece) to count as Brilliant.
    return net_loss >= 200


def _looks_hanging(board: chess.Board, sq: chess.Square) -> bool:
    """A piece on `sq` is 'hanging' if attacked by opponent more than defended,
    or attacked by a strictly cheaper piece. Cheap heuristic, not perfect.
    """
    piece = board.piece_at(sq)
    if piece is None or piece.piece_type == chess.KING:
        return False
    attackers = board.attackers(not piece.color, sq)
    if not attackers:
        return False
    defenders = board.attackers(piece.color, sq)
    own_value = _piece_value(piece)
    cheapest_attacker = min(_piece_value(board.piece_at(s)) for s in attackers)
    if cheapest_attacker < own_value:
        # Opponent has a cheaper attacker — usually losing material even if defended.
        return True
    if not defenders:
        # Attacked, undefended.
        return True
    return False


def _coach_hints(
    board_before: chess.Board,
    move: chess.Move,
    board_after: chess.Board,
    best_move: chess.Move | None,
    eval_before_cp: int,
    eval_after_cp: int,
    is_top1: bool,
) -> list[str]:
    """Produce optional Russian coach-style hints for one ply.

    These run on top of the main classification and call out concrete
    tactical mistakes / opportunities. All checks are local heuristics
    so they are very fast (no extra engine calls).
    """
    hints: list[str] = []
    mover = not board_after.turn  # board_after.turn is opponent's turn now

    # 1) Hanging piece(s) left after the move.
    hanging: list[str] = []
    for sq in chess.SQUARES:
        p = board_after.piece_at(sq)
        if p is None or p.color != mover:
            continue
        if _looks_hanging(board_after, sq):
            hanging.append(chess.piece_name(p.piece_type))
    if hanging and not is_top1 and eval_after_cp < eval_before_cp - 100:
        names = ", ".join(sorted(set(hanging)))
        hints.append(f"Висят фигуры под боем: {names}")

    # 2) Missed defence — before the move, *another* of mover's pieces
    #    was hanging, and the played move didn't move/protect it.
    pre_hanging: list[chess.Square] = []
    for sq in chess.SQUARES:
        p = board_before.piece_at(sq)
        if p is None or p.color != mover:
            continue
        if _looks_hanging(board_before, sq):
            pre_hanging.append(sq)
    if pre_hanging and move.from_square not in pre_hanging:
        # Did the played move actually defend any of them?
        defended_now = [
            sq for sq in pre_hanging
            if board_after.piece_at(sq) is not None
            and not _looks_hanging(board_after, sq)
        ]
        if not defended_now and not is_top1:
            hints.append("Не защитил атакованную фигуру")

    # 3) Best move would have created a fork (attacks 2+ pieces of value ≥ knight).
    if best_move is not None and best_move != move:
        sim = board_before.copy(stack=False)
        sim.push(best_move)
        moved_to = best_move.to_square
        moved_piece = sim.piece_at(moved_to)
        if moved_piece is not None:
            attacked_targets: list[int] = []
            for sq in sim.attacks(moved_to):
                tgt = sim.piece_at(sq)
                if tgt is None or tgt.color == moved_piece.color:
                    continue
                if _piece_value(tgt) >= 320:
                    attacked_targets.append(_piece_value(tgt))
            if len(attacked_targets) >= 2:
                hints.append("Лучший ход создавал двойной удар")

    # 4) King exposure — count opponent attackers on squares around our king.
    king_sq = board_after.king(mover)
    if king_sq is not None:
        ring = chess.SquareSet(chess.BB_KING_ATTACKS[king_sq])
        before_king = board_before.king(mover)
        before_attackers = 0
        if before_king is not None:
            for sq in chess.SquareSet(chess.BB_KING_ATTACKS[before_king]):
                if board_before.attackers(not mover, sq):
                    before_attackers += 1
        after_attackers = 0
        for sq in ring:
            if board_after.attackers(not mover, sq):
                after_attackers += 1
        if after_attackers >= before_attackers + 2 and eval_after_cp < eval_before_cp - 80:
            hints.append("Ослабил позицию короля")

    # 5) Tempo / activity loss when best move was a check or capture.
    if best_move is not None and best_move != move and not is_top1:
        sim = board_before.copy(stack=False)
        sim.push(best_move)
        if sim.is_check():
            hints.append("Лучший ход был с шахом")
        elif board_before.is_capture(best_move) and not board_before.is_capture(move):
            captured = board_before.piece_at(best_move.to_square)
            if captured is not None and _piece_value(captured) >= 320:
                hints.append("Лучший ход выигрывал материал")

    # 6) Pinned piece created by the move (we pin an opponent piece).
    for sq in chess.SQUARES:
        p = board_after.piece_at(sq)
        if p is None or p.color == mover:
            continue
        # python-chess's is_pinned checks if the given side's piece is pinned.
        if board_after.is_pinned(p.color, sq) and not board_before.is_pinned(
            p.color, sq
        ):
            if _piece_value(p) >= 320 and eval_after_cp > eval_before_cp - 30:
                hints.append("Создал связку на фигуру соперника")
                break

    # 7) Weak back-rank — mover's king has no pawn/piece escape
    #    squares on its back rank after the move.
    if king_sq is not None:
        back_rank = 0 if mover == chess.WHITE else 7
        if chess.square_rank(king_sq) == back_rank:
            escape_rank = 1 if mover == chess.WHITE else 6
            # Count non-pawn escape squares in front of the king.
            escape_squares: list[int] = []
            for df in (-1, 0, 1):
                f = chess.square_file(king_sq) + df
                if 0 <= f <= 7:
                    esc = chess.square(f, escape_rank)
                    p = board_after.piece_at(esc)
                    if p is None:
                        escape_squares.append(esc)
            if not escape_squares and not is_top1 and eval_after_cp < eval_before_cp - 50:
                hints.append("Слабая последняя горизонталь")

    # 8) Doubled pawns created by the move (mover's own).
    def _own_pawns_on_file(b: chess.Board, file_: int) -> int:
        n = 0
        for r in range(8):
            piece = b.piece_at(chess.square(file_, r))
            if piece is not None and piece.piece_type == chess.PAWN and piece.color == mover:
                n += 1
        return n

    if move.promotion is None:
        moved = board_before.piece_at(move.from_square)
        if moved is not None and moved.piece_type == chess.PAWN:
            file_after = chess.square_file(move.to_square)
            if (
                _own_pawns_on_file(board_after, file_after) >= 2
                and _own_pawns_on_file(board_before, file_after)
                < _own_pawns_on_file(board_after, file_after)
                and not is_top1
                and eval_after_cp < eval_before_cp - 30
            ):
                hints.append("Сдвоенные пешки")

    return hints


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


def _game_phase(board: chess.Board) -> str:
    """Classify a position as 'opening', 'middlegame', or 'endgame'.

    Uses a simple material/phase score similar to Stockfish's:
    queens=4, rooks=2, minors=1. score >= 18 = middlegame/opening,
    <= 6 = endgame, else middlegame.
    """
    phase_score = 0
    for piece_type, weight in (
        (chess.QUEEN, 4), (chess.ROOK, 2), (chess.BISHOP, 1), (chess.KNIGHT, 1)
    ):
        phase_score += weight * len(board.pieces(piece_type, chess.WHITE))
        phase_score += weight * len(board.pieces(piece_type, chess.BLACK))
    if phase_score <= 6:
        return "endgame"
    if phase_score >= 18 and board.fullmove_number <= 12:
        return "opening"
    return "middlegame"


def _classify(
    *,
    cpl: int,
    eval_before_cp: int,
    eval_after_cp: int,
    is_top1: bool,
    only_move_gap_cp: int,
    is_sacrifice: bool,
    is_hidden_sacrifice: bool,
    in_book: bool,
    wp_loss: float,
    phase: str,
    is_forced: bool,
    is_recapture: bool = False,
) -> tuple[str, str]:
    """Pick a label + short note for one move.

    Mirrors chess.com's classification reasonably closely:
    - Book lookup uses a real opening database (Lichess ECO data).
    - Mistake/Inaccuracy/Blunder thresholds are based on win-percentage
      loss rather than raw CPL — a 100-cp drop in an already winning
      position is far less damaging than the same drop in an equal one.
    - Brilliant requires (a) move is top-1 or near-top, (b) it's a true
      material sacrifice, (c) the position is still winning after.
    - Great is the only-move-that-works case (large gap to the second
      best line) or a critical turn-around.
    """
    # Checkmate delivered: always at least Best (Brilliant if sacrificial).
    if eval_after_cp >= MATE_SCORE - 1:
        if is_sacrifice:
            return "brilliant", "Бриллиантовый ход — мат через жертву"
        return "best", "Мат!"

    # We end up in a position where the opponent has a forced mate.
    if eval_after_cp <= -MATE_SCORE + 1000:
        mate_in = max(1, MATE_SCORE + eval_after_cp)
        # If we were already losing to mate before this move (i.e. every
        # legal reply leads to mate) then we did *not* blunder — we
        # played the best (or a best-equivalent) defensive try.
        already_lost_to_mate = eval_before_cp <= -MATE_SCORE + 1000
        if already_lost_to_mate:
            if is_top1:
                return "best", f"Лучшая попытка в проигранной позиции (мат в {mate_in})"
            # Even in a lost position we can speed up our own demise.
            before_mate_in = max(1, MATE_SCORE + eval_before_cp)
            # Larger mate_in = mate is further away = better defence.
            if mate_in >= before_mate_in:
                # Holding-out at least as long → just call it Good.
                return "good", f"Тянет сопротивление (мат в {mate_in})"
            # Shorter mate than what was forced → speeds up our own demise.
            return "mistake", f"Ускорил мат ({before_mate_in} → {mate_in})"
        # We were not previously losing to mate → genuine blunder.
        return "blunder", f"Подставился под мат в {mate_in}"

    # Book: position is in the opening database.
    if in_book:
        return "book", "Теория"

    # Forced: only one legal move. Don't reward this — it wasn't a
    # decision. Skip if the move is also terrible (still blunder).
    if is_forced and wp_loss < 20.0:
        return "forced", "Вынужденный ход — единственный легальный"

    # Mate-miss / win-miss only fire when the move is *not* the
    # engine's top-1 recommendation. If the player picked the engine's
    # best move and the eval still drops, that is the position's
    # nature — not a missed opportunity — and should fall through to
    # the Best/Excellent path below.
    if not is_top1 and eval_before_cp >= MATE_SCORE - 1000 and eval_after_cp < MATE_SCORE - 1000:
        return "miss", f"Упущен мат ({_pretty_cp(eval_before_cp)} → {_pretty_cp(eval_after_cp)})"
    # Miss: was clearly winning, now isn't.
    if not is_top1 and eval_before_cp >= 300 and eval_after_cp < 100 and cpl >= 100:
        return "miss", f"Упущена победа ({_pretty_cp(eval_before_cp)} → {_pretty_cp(eval_after_cp)})"

    # Brilliant: top-1 + (material sacrifice OR hidden tactical
    # sacrifice — apparent hanging piece that opponent can't take) +
    # still winning + we weren't in a hopelessly lost position + the
    # position wasn't already decisively winning *before* the move
    # (chess.com doesn't hand out Brilliant in overwhelming positions
    # — you're just expected to play best moves there).
    if (
        (is_sacrifice or is_hidden_sacrifice)
        and is_top1
        and eval_after_cp >= 100
        and eval_before_cp >= -200
        and eval_before_cp < 500
    ):
        if is_hidden_sacrifice and not is_sacrifice:
            return "brilliant", "Бриллиантовый ход — скрытая жертва (тактика)"
        return "brilliant", "Бриллиантовый ход — жертва, остаётся выигрышной позиция"

    # Great: only-good-move (tighter — gap must be ≥ 250 cp, like chess.com)
    # OR position turnaround from clearly losing to clearly winning.
    # Obvious recaptures (taking back on the same square opponent just
    # captured on) are NOT Great even with a huge gap — chess.com
    # considers them standard Best-level moves.
    if (
        is_top1
        and only_move_gap_cp >= 250
        and abs(eval_before_cp) < 1000
        and not is_recapture
    ):
        return "great", "Великолепный ход — единственный спасительный"
    if eval_before_cp <= -200 and eval_after_cp >= 150 and not is_recapture:
        return "great", "Великолепный ход — переломил позицию"

    # Best: matches the engine's first line.
    if is_top1:
        return "best", "Лучший ход"

    # Win-percentage-loss (WP-loss) buckets, in % points (0..100).
    # Phase-aware: endgame is stricter (small cp swings mean more
    # there — engine eval is more accurate deep in simplified
    # positions, and decisive positions flip more easily on one move),
    # opening is a touch more forgiving since piece activity / prophylaxis
    # aren't always captured by a one-line eval.
    if phase == "endgame":
        thr_excellent, thr_good, thr_inacc, thr_mistake = 1.5, 4.0, 8.0, 16.0
    elif phase == "opening":
        thr_excellent, thr_good, thr_inacc, thr_mistake = 2.5, 6.0, 12.0, 22.0
    else:
        thr_excellent, thr_good, thr_inacc, thr_mistake = 2.0, 5.0, 10.0, 20.0
    if wp_loss < thr_excellent:
        return "excellent", "Превосходный"
    if wp_loss < thr_good:
        return "good", "Хороший"
    if wp_loss < thr_inacc:
        return "inaccuracy", f"Неточность (−{cpl} cp)"
    if wp_loss < thr_mistake or cpl < 200:
        if cpl < 80:
            return "good", "Хороший"
        if cpl < 150:
            return "inaccuracy", f"Неточность (−{cpl} cp)"
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


def _caps2_game_accuracy(
    per_ply_accuracies: list[float],
    per_ply_wp_before: list[float],
) -> float:
    """Volatility-weighted CAPS2-style accuracy (as used by Lichess,
    close approximation of chess.com's CAPS2). Weights each ply by the
    local WP stdev in a ±2-move window, then averages a weighted-mean
    and a harmonic-mean of per-ply accuracies. This is what makes the
    final number 2-4% lower than a naive mean and what lines our output
    up with chess.com's displayed Accuracy%.
    """
    n = len(per_ply_accuracies)
    if n == 0:
        return 0.0
    if n == 1:
        return per_ply_accuracies[0]
    # Per-ply volatility (stdev of wp_before in a ±2 move window, floored).
    weights: list[float] = []
    for i in range(n):
        lo = max(0, i - 2)
        hi = min(n, i + 3)
        window = per_ply_wp_before[lo:hi]
        if len(window) < 2:
            weights.append(0.5)
            continue
        mean = sum(window) / len(window)
        var = sum((x - mean) ** 2 for x in window) / len(window)
        std = math.sqrt(var)
        # Lichess uses max(0.5, min(12, 100*std)) as weight; we follow.
        weights.append(max(0.5, min(12.0, std * 100.0)))
    total_w = sum(weights)
    weighted_mean = (
        sum(a * w for a, w in zip(per_ply_accuracies, weights, strict=True)) / total_w
    )
    # Harmonic mean — penalises single very-bad moves more strongly.
    positive_accs = [max(1e-6, a) for a in per_ply_accuracies]
    harmonic = n / sum(1.0 / a for a in positive_accs)
    return float(max(0.0, min(100.0, (weighted_mean + harmonic) / 2.0)))


# ---------------------------------------------------------------------------
# Main analysis loop
# ---------------------------------------------------------------------------


async def analyse_game(
    moves_uci: list[str],
    starting_fen: str = chess.STARTING_FEN,
    movetime_ms: int | None = None,
    depth: int | None = 22,
    multipv: int = 3,
    progress_cb: Any = None,
) -> dict[str, Any]:
    """Walk the game, run Stockfish per ply, classify each move."""
    if not engine.is_running:
        raise RuntimeError(
            "Stockfish is not configured. Start the engine first via the UI."
        )
    # Always require *some* engine limit. If the caller explicitly
    # passes both as None we fall back to a sane default depth — this
    # avoids ever issuing chess.engine.Limit(time=None, depth=None),
    # which would let Stockfish search indefinitely and lock the
    # engine for any concurrent request.
    if movetime_ms is None and depth is None:
        depth = 22
    board = chess.Board(starting_fen)
    analyses: list[MoveAnalysis] = []
    accuracies: dict[chess.Color, list[float]] = {chess.WHITE: [], chess.BLACK: []}
    # wp_before tracked per-colour for CAPS2-style volatility weighting.
    wp_before_per_color: dict[chess.Color, list[float]] = {
        chess.WHITE: [], chess.BLACK: []
    }
    cpls: dict[chess.Color, list[int]] = {chess.WHITE: [], chess.BLACK: []}
    counts: dict[str, int] = {label: 0 for label in CLASS_LABELS}
    # Track the opponent's previous move to detect recaptures.
    prev_move: chess.Move | None = None

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
            fen_before, movetime_ms=movetime_ms, depth=depth, multipv=multipv
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

        # Eval after the played move: handle terminal states first (mate,
        # stalemate, draw) before consulting the engine — engines return
        # ambiguous mate(0) scores on already-finished positions.
        board.push(move)
        infos_after: list[dict[str, Any]] = []
        if board.is_checkmate():
            # The mover just delivered mate.
            eval_after_cp = MATE_SCORE
        elif (
            board.is_stalemate()
            or board.is_insufficient_material()
            or board.is_seventyfive_moves()
            or board.is_fivefold_repetition()
        ):
            eval_after_cp = 0
        else:
            infos_after = await engine.analyse_raw(
                board.fen(), movetime_ms=movetime_ms, depth=depth, multipv=1
            )
            eval_after_cp = (
                _score_to_cp(infos_after[0], side_color)
                if infos_after
                else eval_before_cp
            )

        # Hidden-tactic sacrifice: piece that just moved looks "hanging"
        # (could be captured by a cheaper attacker), but the engine's
        # top reply for the opponent isn't to take it — meaning the
        # capture loses to a tactic (pin / discovered / back-rank).
        #
        # Guards against false positives:
        #   * If the move was itself a capture of a piece of equal or
        #     higher value (e.g. BxQ), it is a *winning trade*, not a
        #     sacrifice — even if our piece is now hanging, we're already
        #     net-ahead in material.
        #   * If the opponent's best reply does capture our piece on the
        #     same square, it's just a normal lost-piece blunder / trade.
        is_hidden_sac = False
        moving_piece_val = _piece_value(pre_board.piece_at(move.from_square))
        captured_piece_val = _piece_value(pre_board.piece_at(move.to_square))
        net_winning_trade = captured_piece_val >= moving_piece_val
        if (
            not is_sac
            and not net_winning_trade
            and board.piece_at(move.to_square) is not None
            and _looks_hanging(board, move.to_square)
            and infos_after
        ):
            opp_pv = infos_after[0].get("pv") or []
            if opp_pv:
                opp_best = opp_pv[0]
                if opp_best.to_square != move.to_square:
                    is_hidden_sac = True

        cpl = max(0, eval_before_cp - eval_after_cp)

        # Win-percentage loss for this ply, in % points (0..100).
        wp_before = _winning_chances(eval_before_cp)
        wp_after = _winning_chances(eval_after_cp)
        wp_loss_pct = max(0.0, (wp_before - wp_after) * 100.0)

        # Book lookup: position before the move must be in the book AND
        # the move itself must keep us in the book (else it's a deviation).
        # Local ECO book is consulted first; if either position is unknown
        # we optionally fall back to the Lichess Masters API (much bigger
        # corpus — millions of 2200+ ELO master games).
        in_book = is_book_position(fen_before) and is_book_position(board.fen())
        if not in_book and pre_board.fullmove_number <= 20:
            in_book = (
                await masters_in_book(fen_before)
                and await masters_in_book(board.fen())
            )

        # Phase + forced-move detection: run before `_classify` so
        # phase-aware WP thresholds and Forced branch kick in.
        phase = _game_phase(pre_board)
        # legal move count BEFORE the move was played
        is_forced = len(list(pre_board.legal_moves)) == 1

        # Recapture detection: our move captures on the same square
        # where the opponent's last move landed (i.e. took back).
        is_recapture = (
            prev_move is not None
            and pre_board.is_capture(move)
            and move.to_square == prev_move.to_square
        )

        # Draw-aware override: if the position after the move is a
        # dead draw by rule (insufficient material, 3-fold, 50-move,
        # stalemate) clamp both evals so the classifier treats them
        # as equal.
        if (
            board.is_stalemate()
            or board.is_insufficient_material()
            or board.is_fifty_moves()
            or board.is_repetition(3)
        ):
            eval_after_cp = 0
            cpl = max(0, eval_before_cp)
            # Recompute dependent WP metrics so `_classify` (which
            # reads wp_loss) sees the correct post-draw delta.
            wp_after = _winning_chances(eval_after_cp)
            wp_loss_pct = max(0.0, (wp_before - wp_after) * 100.0)

        label, note = _classify(
            cpl=cpl,
            eval_before_cp=eval_before_cp,
            eval_after_cp=eval_after_cp,
            is_top1=is_top1,
            only_move_gap_cp=only_move_gap_cp,
            is_sacrifice=is_sac,
            is_hidden_sacrifice=is_hidden_sac,
            in_book=in_book,
            wp_loss=wp_loss_pct,
            phase=phase,
            is_forced=is_forced,
            is_recapture=is_recapture,
        )
        counts[label] = counts.get(label, 0) + 1

        # Cheap, local-only coach hints (no extra engine call).
        coach = _coach_hints(
            board_before=pre_board,
            move=move,
            board_after=board,
            best_move=best_move,
            eval_before_cp=eval_before_cp,
            eval_after_cp=eval_after_cp,
            is_top1=is_top1,
        )

        accuracies[side_color].append(_accuracy_for_pair(wp_before, wp_after))
        wp_before_per_color[side_color].append(wp_before)
        # Cap per-ply CPL for ACPL averaging — a single forced-mate
        # blowout otherwise dominates the average and makes the metric
        # meaningless. chess.com does the same kind of capping.
        cpls[side_color].append(min(cpl, 1000))

        prev_move = move

        best_san = None
        if best_move is not None:
            best_san = pre_board.san(best_move)

        # Serialise the engine's top-1 PV (up to 5 plies) for the UI
        # to draw arrows / show best-line continuation.
        best_pv_uci: list[str] = []
        best_pv_san: list[str] = []
        if best_pv:
            sim = pre_board.copy(stack=False)
            for pv_move in best_pv[:10]:
                if pv_move not in sim.legal_moves:
                    break
                best_pv_uci.append(pv_move.uci())
                best_pv_san.append(sim.san(pv_move))
                sim.push(pv_move)

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
                coach=coach or None,
                best_pv_uci=best_pv_uci or None,
                best_pv_san=best_pv_san or None,
            )
        )

        if progress_cb is not None:
            await progress_cb(ply_index + 1, len(moves_uci))

    def _avg(xs: list[float] | list[int]) -> float:
        return float(sum(xs) / len(xs)) if xs else 0.0

    # Key moments: top-5 plies by "turning-point" magnitude — biggest
    # WP swings, with a preference for genuine mistakes/brilliancies
    # over even-position trivia. Skipped if fewer than 5 plies.
    key_moments: list[dict[str, Any]] = []
    if analyses:
        ranked = sorted(
            analyses,
            key=lambda m: abs(
                _winning_chances(m.eval_before_cp)
                - _winning_chances(m.eval_after_cp)
            ),
            reverse=True,
        )
        seen_plies: set[int] = set()
        for a in ranked:
            if a.ply in seen_plies:
                continue
            wp_delta = abs(
                _winning_chances(a.eval_before_cp)
                - _winning_chances(a.eval_after_cp)
            )
            if wp_delta < 0.05:
                continue
            # Prefer a spread across the game — skip a ply if we already
            # have one within ±1 of it (so we don't spam key moments on
            # a single tactical sequence).
            if any(abs(a.ply - p) <= 1 for p in seen_plies):
                continue
            seen_plies.add(a.ply)
            key_moments.append({
                "ply": a.ply,
                "side": a.side,
                "move_san": a.move_san,
                "classification": a.classification,
                "note": a.note,
                "eval_before_cp": a.eval_before_cp,
                "eval_after_cp": a.eval_after_cp,
                "wp_delta": round(wp_delta * 100, 1),
            })
            if len(key_moments) >= 5:
                break

    summary = {
        "white": {
            "accuracy": round(
                _caps2_game_accuracy(
                    accuracies[chess.WHITE], wp_before_per_color[chess.WHITE]
                ),
                1,
            ),
            "acpl": round(_avg(cpls[chess.WHITE]), 1),
            "moves": len(cpls[chess.WHITE]),
        },
        "black": {
            "accuracy": round(
                _caps2_game_accuracy(
                    accuracies[chess.BLACK], wp_before_per_color[chess.BLACK]
                ),
                1,
            ),
            "acpl": round(_avg(cpls[chess.BLACK]), 1),
            "moves": len(cpls[chess.BLACK]),
        },
        "counts": counts,
    }

    return {
        "moves": [m.to_dict() for m in analyses],
        "summary": summary,
        "key_moments": key_moments,
    }


# Helper: import_game from a thread (it does HTTP).
async def import_game_async(source: str) -> ImportedGame:
    return await asyncio.to_thread(import_game, source)
