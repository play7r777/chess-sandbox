"""Tactical puzzle bank — SQLite-first with a JSON fallback.

If the SQLite database produced by ``python -m backend.import_puzzles``
exists at ``backend/data/puzzles.sqlite``, every query reads from it.
Otherwise the module falls back to the bundled
``backend/data/puzzles.json`` (a small ~90-puzzle pack used for
development).

The Russian theme labels (``theme_ru``) live in the JSON file and are
loaded once on first call regardless of which backend is in use.
"""
from __future__ import annotations

import json
import random
from functools import lru_cache
from typing import Any

from . import puzzle_db
from .settings import settings

# ---------------------------------------------------------------------------
# JSON fallback (small bundled pack)
# ---------------------------------------------------------------------------

@lru_cache(maxsize=1)
def _load_json() -> dict[str, Any]:
    path = settings.backend_root / "data" / "puzzles.json"
    if not path.exists():
        return {"theme_ru": {}, "puzzles": []}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or "puzzles" not in data:
        return {"theme_ru": {}, "puzzles": []}
    return data


def _json_puzzles() -> list[dict[str, Any]]:
    return list(_load_json().get("puzzles", []))


# ---------------------------------------------------------------------------
# Difficulty band (must match puzzle_db.import_puzzles._difficulty)
# ---------------------------------------------------------------------------

def difficulty_band(p: dict[str, Any]) -> str:
    explicit = p.get("difficulty")
    if isinstance(explicit, str) and explicit:
        return explicit
    rating = int(p.get("rating") or 0)
    if rating < 1100:
        return "easy"
    if rating < 1700:
        return "medium"
    return "hard"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def using_sqlite() -> bool:
    return puzzle_db.is_available()


def theme_labels() -> dict[str, str]:
    """Russian-language labels for each Lichess theme key."""
    return dict(_load_json().get("theme_ru", {}))


def all_puzzles() -> list[dict[str, Any]]:
    """Legacy helper: return *all* puzzles in memory.

    Kept for the JSON fallback only. With the SQLite store this would
    pull 500 000+ rows into RAM — call :func:`sample_puzzles` instead.
    """
    if using_sqlite():
        # Discourage misuse but still answer truthfully if the caller insists.
        return puzzle_db.filter_puzzles()
    return _json_puzzles()


def sample_puzzles(n: int) -> list[dict[str, Any]]:
    """Return *n* random puzzles, suitable for a party-room queue."""
    if using_sqlite():
        return puzzle_db.sample_puzzles(n)
    pool = list(_json_puzzles())
    random.shuffle(pool)
    return pool[:n] if n > 0 else pool


def filter_puzzles(
    *,
    difficulty: str | None = None,
    theme: str | None = None,
    min_rating: int | None = None,
    max_rating: int | None = None,
) -> list[dict[str, Any]]:
    if using_sqlite():
        return puzzle_db.filter_puzzles(
            difficulty=difficulty, theme=theme,
            min_rating=min_rating, max_rating=max_rating,
        )
    out: list[dict[str, Any]] = []
    for p in _json_puzzles():
        if difficulty and difficulty_band(p) != difficulty:
            continue
        if theme and theme not in (p.get("themes") or []):
            continue
        rating = int(p.get("rating") or 0)
        if min_rating is not None and rating < min_rating:
            continue
        if max_rating is not None and rating > max_rating:
            continue
        out.append(p)
    return out


def random_puzzle(
    *,
    difficulty: str | None = None,
    theme: str | None = None,
    min_rating: int | None = None,
    max_rating: int | None = None,
    exclude_ids: set[str] | None = None,
) -> dict[str, Any] | None:
    if using_sqlite():
        return puzzle_db.random_puzzle(
            difficulty=difficulty, theme=theme,
            min_rating=min_rating, max_rating=max_rating,
            exclude_ids=exclude_ids,
        )
    pool = filter_puzzles(
        difficulty=difficulty, theme=theme,
        min_rating=min_rating, max_rating=max_rating,
    )
    if exclude_ids:
        pool = [p for p in pool if p.get("id") not in exclude_ids]
    if not pool:
        return None
    return random.choice(pool)


def get_by_id(puzzle_id: str) -> dict[str, Any] | None:
    if using_sqlite():
        return puzzle_db.get_by_id(puzzle_id)
    for p in _json_puzzles():
        if p.get("id") == puzzle_id:
            return p
    return None


def stats() -> dict[str, Any]:
    """Pack-level metadata: counts, difficulty bands, theme labels."""
    labels = theme_labels()
    if using_sqlite():
        sqlite_bands = puzzle_db.stats()
        return {
            "count": sum(sqlite_bands.values()),
            "by_difficulty": sqlite_bands,
            "by_theme": {},  # too expensive to compute on every request
            "theme_labels": labels,
            "source": "sqlite",
        }
    pz = _json_puzzles()
    json_bands: dict[str, int] = {}
    by_theme: dict[str, int] = {}
    for p in pz:
        band = difficulty_band(p)
        json_bands[band] = json_bands.get(band, 0) + 1
        for t in p.get("themes") or []:
            by_theme[t] = by_theme.get(t, 0) + 1
    return {
        "count": len(pz),
        "by_difficulty": json_bands,
        "by_theme": by_theme,
        "theme_labels": labels,
        "source": "json",
    }
