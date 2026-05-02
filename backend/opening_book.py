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

import gzip
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

_DATA_FILE = Path(__file__).parent / "data" / "openings.txt.gz"
_BOOK: set[str] | None = None


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
