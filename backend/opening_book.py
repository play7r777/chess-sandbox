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


def _masters_sync(fen: str) -> bool:
    """Blocking call to the Lichess Masters explorer. Returns True if
    the given position has at least one master-level game. Any network
    failure returns False (treated as "unknown — not in book")."""
    try:
        r = requests.get(
            _MASTERS_URL,
            params={"fen": fen, "moves": 0, "topGames": 0, "recentGames": 0},
            headers={"Accept": "application/json"},
            timeout=4,
        )
        if r.status_code != 200:
            return False
        data = r.json()
        total = int(data.get("white", 0) + data.get("draws", 0) + data.get("black", 0))
        return total > 0
    except (requests.RequestException, ValueError):
        return False


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
