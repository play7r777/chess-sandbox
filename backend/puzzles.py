"""Local tactical-puzzle bank.

The puzzle pack lives at ``backend/data/puzzles.json`` and is a curated
sample of the public Lichess Puzzle Database. Each entry follows the
Lichess CSV layout — the ``moves`` array starts with the opponent's
*setup* move (which the frontend auto-plays), then the user's
expected first move, then the forced opponent reply, and so on.

This module just loads the pack once at startup and exposes a couple
of convenience filters used by the ``/api/puzzle/*`` endpoints.
"""
from __future__ import annotations

import json
import random
from functools import lru_cache
from typing import Any

from .settings import settings


@lru_cache(maxsize=1)
def _load() -> dict[str, Any]:
    """Load and cache the puzzle pack from disk."""
    path = settings.backend_root / "data" / "puzzles.json"
    if not path.exists():
        return {"theme_ru": {}, "puzzles": []}
    with path.open("r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or "puzzles" not in data:
        return {"theme_ru": {}, "puzzles": []}
    return data


def all_puzzles() -> list[dict[str, Any]]:
    return list(_load().get("puzzles", []))


def theme_labels() -> dict[str, str]:
    return dict(_load().get("theme_ru", {}))


def difficulty_band(p: dict[str, Any]) -> str:
    rating = int(p.get("rating") or 0)
    if rating < 1100:
        return "easy"
    if rating < 1700:
        return "medium"
    return "hard"


def filter_puzzles(
    *,
    difficulty: str | None = None,
    theme: str | None = None,
    min_rating: int | None = None,
    max_rating: int | None = None,
) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for p in all_puzzles():
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
    pool = filter_puzzles(
        difficulty=difficulty,
        theme=theme,
        min_rating=min_rating,
        max_rating=max_rating,
    )
    if exclude_ids:
        pool = [p for p in pool if p.get("id") not in exclude_ids]
    if not pool:
        return None
    return random.choice(pool)


def get_by_id(puzzle_id: str) -> dict[str, Any] | None:
    for p in all_puzzles():
        if p.get("id") == puzzle_id:
            return p
    return None


def stats() -> dict[str, Any]:
    pz = all_puzzles()
    by_band: dict[str, int] = {}
    by_theme: dict[str, int] = {}
    for p in pz:
        by_band[difficulty_band(p)] = by_band.get(difficulty_band(p), 0) + 1
        for t in p.get("themes") or []:
            by_theme[t] = by_theme.get(t, 0) + 1
    return {
        "count": len(pz),
        "by_difficulty": by_band,
        "by_theme": by_theme,
        "theme_labels": theme_labels(),
    }
