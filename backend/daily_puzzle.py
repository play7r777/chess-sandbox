"""Daily Puzzle — one shared puzzle per UTC date.

Selection is deterministic: the (sorted) puzzle bank is hashed against
the ISO date and the row at that index is the puzzle of the day. That
means every user worldwide gets the *same* puzzle, can compare solve
times on the daily leaderboard, and we don't need to persist a separate
"today's puzzle" record — re-running the function on the same date
always returns the same row.

Streak counters and per-day attempts live on the user profile (see
``users.record_daily_puzzle_attempt``). This module is mostly the
selector + a thin lookup helper.
"""
from __future__ import annotations

import hashlib
import time
from typing import Any

from . import puzzles as puzzle_pack

# Inclusive rating band for the daily puzzle. Lichess's "Daily Puzzle"
# tends to sit somewhere between 1500 and 2400 — a tad on the harder
# side so the leaderboard isn't a coin flip on solve time. We pull from
# this band first; if it's empty (e.g. tiny JSON fallback bank) we widen.
DAILY_MIN_RATING = 1500
DAILY_MAX_RATING = 2400


def today_iso() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


def _candidate_pool() -> list[dict[str, Any]]:
    pool = puzzle_pack.filter_puzzles(
        min_rating=DAILY_MIN_RATING, max_rating=DAILY_MAX_RATING
    )
    if not pool:
        pool = puzzle_pack.filter_puzzles()
    if not pool:
        pool = list(puzzle_pack.sample_puzzles(64))
    return pool


def _index_for(date: str, pool_size: int) -> int:
    """Stable index in ``[0, pool_size)`` derived from ``date``."""
    if pool_size <= 0:
        return 0
    digest = hashlib.sha256(date.encode("utf-8")).digest()
    n = int.from_bytes(digest[:8], "big", signed=False)
    return n % pool_size


def get_for_date(date: str | None = None) -> dict[str, Any] | None:
    """Return the puzzle picked for ``date`` (defaults to today UTC)."""
    target = date or today_iso()
    pool = _candidate_pool()
    if not pool:
        return None
    pool.sort(key=lambda p: str(p.get("id") or ""))
    idx = _index_for(target, len(pool))
    return pool[idx]


def public_payload(p: dict[str, Any], *, date: str) -> dict[str, Any]:
    """Trim a puzzle row to the fields the daily-puzzle UI needs."""
    return {
        "date": date,
        "id": str(p.get("id") or ""),
        "fen": str(p.get("fen") or ""),
        "moves": list(p.get("moves") or []),
        "rating": int(p.get("rating") or 1500),
        "themes": list(p.get("themes") or []),
        "url": p.get("url"),
    }
