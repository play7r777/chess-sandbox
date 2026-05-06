"""SQLite-backed puzzle store for the Lichess puzzle dataset.

After running ``python -m backend.import_puzzles`` the database lives at
``backend/data/puzzles.sqlite`` and holds up to 500 000+ puzzles with
indexes on *rating*, *difficulty*, and every individual theme.

All public functions are **read-only** and safe to call from any
async/sync context (SQLite in WAL mode + read-only connections).
"""
from __future__ import annotations

import random
import sqlite3
from functools import lru_cache
from pathlib import Path
from typing import Any

from .settings import settings

DB_PATH: Path = settings.data_dir / "puzzles.sqlite"

# ---------------------------------------------------------------------------
# Connection helpers
# ---------------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA query_only=ON")
    return conn


@lru_cache(maxsize=1)
def _conn() -> sqlite3.Connection:
    """Module-level singleton; opened once on first use."""
    return _connect()


def is_available() -> bool:
    """Return True when the SQLite puzzle database exists on disk."""
    return DB_PATH.is_file()


# ---------------------------------------------------------------------------
# Public query API (mirrors the old puzzles.py surface)
# ---------------------------------------------------------------------------

def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d: dict[str, Any] = dict(row)
    raw_moves = d.get("moves") or ""
    d["moves"] = raw_moves.split() if isinstance(raw_moves, str) else raw_moves
    raw_themes = d.get("themes") or ""
    d["themes"] = raw_themes.split() if isinstance(raw_themes, str) else raw_themes
    return d


def count(
    *,
    difficulty: str | None = None,
    theme: str | None = None,
    min_rating: int | None = None,
    max_rating: int | None = None,
) -> int:
    where, params = _build_where(difficulty=difficulty, theme=theme,
                                  min_rating=min_rating, max_rating=max_rating)
    sql = f"SELECT COUNT(*) FROM puzzles{where}"
    row = _conn().execute(sql, params).fetchone()
    return int(row[0]) if row else 0


def random_puzzle(
    *,
    difficulty: str | None = None,
    theme: str | None = None,
    min_rating: int | None = None,
    max_rating: int | None = None,
    exclude_ids: set[str] | None = None,
) -> dict[str, Any] | None:
    where, params = _build_where(
        difficulty=difficulty, theme=theme,
        min_rating=min_rating, max_rating=max_rating,
        exclude_ids=exclude_ids,
    )
    # Fast random row via random offset.
    cnt_sql = f"SELECT COUNT(*) FROM puzzles{where}"
    cnt_row = _conn().execute(cnt_sql, params).fetchone()
    total = int(cnt_row[0]) if cnt_row else 0
    if total == 0:
        return None
    offset = random.randint(0, total - 1)
    sql = f"SELECT * FROM puzzles{where} LIMIT 1 OFFSET ?"
    row = _conn().execute(sql, params + [offset]).fetchone()
    return _row_to_dict(row) if row else None


def get_by_id(puzzle_id: str) -> dict[str, Any] | None:
    row = _conn().execute("SELECT * FROM puzzles WHERE id = ?", (puzzle_id,)).fetchone()
    return _row_to_dict(row) if row else None


def sample_puzzles(n: int) -> list[dict[str, Any]]:
    """Return *n* random puzzles — used by party rooms to build a queue."""
    rows = _conn().execute("SELECT * FROM puzzles ORDER BY RANDOM() LIMIT ?", (n,)).fetchall()
    return [_row_to_dict(r) for r in rows]


def filter_puzzles(
    *,
    difficulty: str | None = None,
    theme: str | None = None,
    min_rating: int | None = None,
    max_rating: int | None = None,
) -> list[dict[str, Any]]:
    where, params = _build_where(
        difficulty=difficulty, theme=theme,
        min_rating=min_rating, max_rating=max_rating,
    )
    rows = _conn().execute(f"SELECT * FROM puzzles{where}", params).fetchall()
    return [_row_to_dict(r) for r in rows]


def stats() -> dict[str, int]:
    """Aggregate counts by difficulty band."""
    rows = _conn().execute(
        "SELECT difficulty, COUNT(*) AS cnt FROM puzzles GROUP BY difficulty"
    ).fetchall()
    return {r["difficulty"]: r["cnt"] for r in rows}


def theme_counts() -> dict[str, int]:
    """Count puzzles per theme (iterates over space-joined themes column)."""
    acc: dict[str, int] = {}
    cur = _conn().execute("SELECT themes FROM puzzles")
    while True:
        batch = cur.fetchmany(5000)
        if not batch:
            break
        for row in batch:
            for t in (row["themes"] or "").split():
                acc[t] = acc.get(t, 0) + 1
    return acc


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _build_where(
    *,
    difficulty: str | None = None,
    theme: str | None = None,
    min_rating: int | None = None,
    max_rating: int | None = None,
    exclude_ids: set[str] | None = None,
) -> tuple[str, list[Any]]:
    clauses: list[str] = []
    params: list[Any] = []
    if difficulty:
        clauses.append("difficulty = ?")
        params.append(difficulty)
    if theme:
        # themes column is space-joined; use LIKE for single-token match.
        clauses.append("(' ' || themes || ' ') LIKE ?")
        params.append(f"% {theme} %")
    if min_rating is not None:
        clauses.append("rating >= ?")
        params.append(min_rating)
    if max_rating is not None:
        clauses.append("rating <= ?")
        params.append(max_rating)
    if exclude_ids:
        placeholders = ",".join("?" for _ in exclude_ids)
        clauses.append(f"id NOT IN ({placeholders})")
        params.extend(sorted(exclude_ids))
    where = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where, params
