"""Opening-book lookup using the Lichess chess-openings ECO data.

The TSV source files (CC0) live at:
    https://github.com/lichess-org/chess-openings

We ship a precomputed list of all positions reachable from any
catalogued ECO line (placement + side-to-move + castling rights +
en-passant — halfmove/fullmove counters intentionally omitted so
transpositions match). The file is gzipped at ~50 KB and loads lazily
on first lookup.

This is the same approach Lichess uses for its "Book moves" indicator
and is a strong proxy for chess.com's `Book` classification.
"""
from __future__ import annotations

import asyncio
import gzip
import logging
from pathlib import Path
from typing import Any

import requests  # type: ignore[import-untyped]

logger = logging.getLogger(__name__)

_DATA_FILE = Path(__file__).parent / "data" / "openings.txt.gz"
_BOOK: set[str] | None = None

# Lichess Masters opening explorer — free, public, no auth. Returns a JSON
# body with a `white`/`black`/`draws` count and a list of master games
# for any FEN in their 2.4M+ game corpus (avg rating ≥ 2200).
_MASTERS_URL = "https://explorer.lichess.ovh/masters"
_MASTERS_CACHE: dict[str, bool] = {}
_MASTERS_LOCK = asyncio.Lock()


def _load() -> set[str]:
    global _BOOK
    if _BOOK is not None:
        return _BOOK
    if not _DATA_FILE.is_file():
        logger.warning("Opening book file missing at %s", _DATA_FILE)
        _BOOK = set()
        return _BOOK
    try:
        with gzip.open(_DATA_FILE, "rt", encoding="utf-8") as fh:
            _BOOK = {line.strip() for line in fh if line.strip()}
        logger.info("Loaded opening book: %d positions", len(_BOOK))
    except OSError as exc:
        logger.warning("Failed to read opening book: %s", exc)
        _BOOK = set()
    return _BOOK


def _key(fen: str) -> str:
    """Normalise FEN to placement + side + castling + ep (drop counters)."""
    parts = fen.split()
    return " ".join(parts[:4]) if len(parts) >= 4 else fen


def is_book_position(fen: str) -> bool:
    """True if this position is found in the opening database."""
    return _key(fen) in _load()


def book_size() -> int:
    return len(_load())


# Minimum number of master games required for a position to count
# as "Book" — chess.com-style thresholding (rare lines don't qualify).
_MASTERS_MIN_GAMES = 5

_MASTERS_DETAIL_CACHE: dict[str, dict[str, Any]] = {}


def _masters_fetch(fen: str, *, with_top_moves: bool) -> dict[str, Any] | None:
    """Blocking Lichess Masters explorer call. Returns the raw JSON
    (with `moves`, `white`, `draws`, `black`) or None on failure."""
    try:
        r = requests.get(
            _MASTERS_URL,
            params={
                "fen": fen,
                "moves": 12 if with_top_moves else 0,
                "topGames": 0,
                "recentGames": 0,
            },
            headers={"Accept": "application/json"},
            timeout=4,
        )
        if r.status_code != 200:
            return None
        data = r.json()
        return data if isinstance(data, dict) else None
    except (requests.RequestException, ValueError):
        return None


def _masters_sync(fen: str) -> bool:
    """Returns True only if the position has ≥ _MASTERS_MIN_GAMES master
    games — a popularity-gated check, closer to chess.com's Book rule."""
    data = _masters_fetch(fen, with_top_moves=False)
    if not data:
        return False
    total = int(data.get("white", 0) + data.get("draws", 0) + data.get("black", 0))
    return total >= _MASTERS_MIN_GAMES


async def masters_in_book(fen: str) -> bool:
    """Async-friendly Lichess Masters lookup with an in-process cache.

    This is a best-effort augmentation on top of the local ECO book:
    we only call it when the local lookup misses AND we're still in
    the first 20 moves. Cache is process-global so each unique FEN
    hits the network at most once per session.
    """
    key = _key(fen)
    cached = _MASTERS_CACHE.get(key)
    if cached is not None:
        return cached
    async with _MASTERS_LOCK:
        # Re-check in case another concurrent request populated it.
        cached = _MASTERS_CACHE.get(key)
        if cached is not None:
            return cached
        result = await asyncio.to_thread(_masters_sync, fen)
        _MASTERS_CACHE[key] = result
        return result


async def masters_top_moves(fen: str, limit: int = 5) -> list[dict[str, Any]]:
    """Return the top master replies for a position with win percentages.

    Output: list of dicts {san, uci, white, draws, black, total, white_pct,
    draw_pct, black_pct}. Empty list on any failure. Cached per position.
    """
    key = _key(fen)
    cached = _MASTERS_DETAIL_CACHE.get(key)
    if cached is None:
        data = await asyncio.to_thread(
            lambda: _masters_fetch(fen, with_top_moves=True)
        )
        cached = data or {}
        _MASTERS_DETAIL_CACHE[key] = cached
    moves_data = cached.get("moves") or []
    out: list[dict[str, Any]] = []
    for m in moves_data[:limit]:
        w, d, b = int(m.get("white", 0)), int(m.get("draws", 0)), int(m.get("black", 0))
        total = w + d + b
        if total == 0:
            continue
        out.append({
            "san": m.get("san", ""),
            "uci": m.get("uci", ""),
            "white": w, "draws": d, "black": b, "total": total,
            "white_pct": round(100.0 * w / total, 1),
            "draw_pct": round(100.0 * d / total, 1),
            "black_pct": round(100.0 * b / total, 1),
        })
    return out
