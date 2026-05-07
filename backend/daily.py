"""Daily Puzzle module — one shared puzzle per day for everyone.

The puzzle is picked deterministically from the SQLite bank using the
date (UTC) as a hash seed, restricted to a curated rating window so
the daily challenge has a consistent difficulty (1300–1900). Every
client that hits ``/api/daily/today`` on the same date receives the
*same* puzzle, which lets us run a leaderboard on solve time.

Solving the daily increments the user's streak (``daily.streak`` in
their profile); failing it breaks the chain. A user only gets one
attempt per day — second hits return the recorded outcome unchanged.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
from typing import Any

from . import puzzle_db, puzzles, users

# Curated rating window for the daily challenge. Picks a meaty middle
# range so neither beginners nor titled players are bored. Wide enough
# that a ~100 puzzle bank never starves the picker.
DAILY_MIN_RATING = 1300
DAILY_MAX_RATING = 1900


def today_key(now: _dt.datetime | None = None) -> str:
    """Return the UTC ``YYYY-MM-DD`` key for today (or a supplied moment).

    UTC keeps the daily synchronized across timezones — everyone gets the
    new puzzle at 00:00 UTC, no matter their local clock.
    """
    if now is None:
        now = _dt.datetime.now(_dt.timezone.utc)
    return now.strftime("%Y-%m-%d")


def _puzzle_for(date_key: str) -> dict[str, Any] | None:
    """Deterministically pick a puzzle for the given date.

    Strategy: hash the date string into a 64-bit int, then pick the
    matching row by rowid offset within the rating window. Same date →
    same offset → same puzzle, regardless of how many times we call.
    """
    if not puzzles.using_sqlite():
        # JSON fallback: just hash into the filtered list.
        pool = puzzles.filter_puzzles(
            min_rating=DAILY_MIN_RATING,
            max_rating=DAILY_MAX_RATING,
        )
        if not pool:
            return None
        seed = int(hashlib.sha256(date_key.encode("utf-8")).hexdigest(), 16)
        return pool[seed % len(pool)]
    # SQLite path: count rows in the window, hash for a stable offset.
    total = puzzle_db.count(min_rating=DAILY_MIN_RATING, max_rating=DAILY_MAX_RATING)
    if total <= 0:
        return None
    seed = int(hashlib.sha256(date_key.encode("utf-8")).hexdigest(), 16)
    offset = seed % total
    conn = puzzle_db._conn()  # noqa: SLF001 — internal but stable
    row = conn.execute(
        "SELECT * FROM puzzles WHERE rating BETWEEN ? AND ? "
        "ORDER BY rowid LIMIT 1 OFFSET ?",
        (DAILY_MIN_RATING, DAILY_MAX_RATING, offset),
    ).fetchone()
    if row is None:
        return None
    return puzzle_db._row_to_dict(row)  # noqa: SLF001


def get_today(client_id: str | None = None) -> dict[str, Any]:
    """Return today's daily-puzzle payload + the user's per-day status.

    Shape:
      {
        "date": "YYYY-MM-DD",
        "puzzle": {...sanitized lichess puzzle...},
        "streak": int,           # current consecutive-day chain
        "best_streak": int,
        "last_solved": "YYYY-MM-DD",
        "today_outcome": null | "solved" | "failed",
        "today_solve_ms": int | null,
        "attempted_today": bool,
      }
    """
    date_key = today_key()
    p = _puzzle_for(date_key)
    payload = {
        "date": date_key,
        "puzzle": _sanitize_puzzle(p) if p else None,
        "streak": 0,
        "best_streak": 0,
        "last_solved": "",
        "today_outcome": None,
        "today_solve_ms": None,
        "attempted_today": False,
    }
    if client_id:
        bag = users.get_daily_progress(client_id)
        payload["streak"] = bag.get("streak", 0)
        payload["best_streak"] = bag.get("best_streak", 0)
        payload["last_solved"] = bag.get("last_solved", "")
        rec = (bag.get("attempts") or {}).get(date_key)
        if isinstance(rec, dict):
            payload["today_outcome"] = rec.get("outcome")
            payload["today_solve_ms"] = int(rec.get("solve_ms") or 0)
            payload["attempted_today"] = True
    return payload


def submit_attempt(
    client_id: str,
    *,
    outcome: str,
    solve_ms: int,
    played_moves: list[str] | None = None,
) -> dict[str, Any] | None:
    """Validate + record a daily attempt.

    Server-side validates ``played_moves`` against the canonical
    solution from the puzzle bank — clients can't fake a solve by just
    POSTing ``outcome=solved``. Mismatched moves coerce the outcome to
    ``failed`` (and the streak breaks accordingly).
    """
    date_key = today_key()
    puzzle = _puzzle_for(date_key)
    if puzzle is None:
        return None
    if outcome not in ("solved", "failed"):
        return None
    # Server-authoritative validation: the user's moves must equal the
    # solver-side ply slices of the puzzle's ``moves`` array.
    if outcome == "solved":
        expected = (puzzle.get("moves") or [])[1::2]
        if not _moves_match(played_moves or [], expected):
            outcome = "failed"
        elif int(solve_ms) < 200:
            # Sanity check: physically impossible to play 4+ moves in 200ms.
            outcome = "failed"
    bag = users.record_daily_attempt(
        client_id,
        date_key=date_key,
        puzzle_id=str(puzzle.get("id") or ""),
        outcome=outcome,
        solve_ms=int(solve_ms or 0),
    )
    if bag is None:
        return None
    return {
        "date": date_key,
        "outcome": outcome,
        "streak": bag["streak"],
        "best_streak": bag["best_streak"],
        "puzzle_id": str(puzzle.get("id") or ""),
    }


def leaderboard() -> list[dict[str, Any]]:
    return users.list_daily_leaderboard(today_key())


def _moves_match(played: list[str], expected: list[str]) -> bool:
    """Compare client's moves against the canonical solver ply list.

    UCI strings, normalized to lowercase. Promotion suffix is matched
    when present. We require exact length + token equality so a client
    that ducked out of half the line doesn't claim the full solve.
    """
    if not isinstance(played, list) or not isinstance(expected, list):
        return False
    if len(played) != len(expected):
        return False
    for a, b in zip(played, expected, strict=False):
        if not isinstance(a, str) or not isinstance(b, str):
            return False
        if a.strip().lower() != b.strip().lower():
            return False
    return True


def _sanitize_puzzle(p: dict[str, Any]) -> dict[str, Any]:
    """Trim the row dict to fields the client needs (no internal cols)."""
    moves = p.get("moves") or []
    if isinstance(moves, str):
        moves = moves.split()
    themes = p.get("themes") or []
    if isinstance(themes, str):
        themes = themes.split()
    return {
        "id": p.get("id"),
        "fen": p.get("fen"),
        "moves": list(moves),
        "rating": int(p.get("rating") or 1500),
        "themes": list(themes),
        "url": p.get("url"),
    }
