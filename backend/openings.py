"""Opening Trainer — curated opening repertoire with theory + practice drills.

The openings live in ``backend/data/openings.json`` (ten curated lines
covering the most common debuts on each side). Each opening has:

  * id, name, eco, side ('w' or 'b' — which side the user practices)
  * description (short blurb)
  * theory (markdown-ish freeform string with key ideas, plans, traps)
  * lines: list of named variations, each one a sequence of moves with
    coach commentary (``move``, ``san``, ``fen_after``, ``why``,
    ``mistakes`` — common amateur deviations and why they're bad).

Practice mode walks the user through the main line: they make a move,
the trainer compares against ``move``; on a wrong move the coach pulls
out the matching ``mistakes`` entry (or generic feedback) and asks them
to try again. Persistence happens via ``users.record_opening_drill``.
"""
from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from . import users
from .settings import settings

_OPENINGS_PATH: Path = settings.data_dir / "openings.json"


@lru_cache(maxsize=1)
def _load_openings() -> list[dict[str, Any]]:
    """Read the curated openings JSON. Cached for the lifetime of the process."""
    if not _OPENINGS_PATH.exists():
        return []
    try:
        with _OPENINGS_PATH.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(data, list):
        return []
    return [o for o in data if isinstance(o, dict) and o.get("id")]


def list_openings(client_id: str | None = None) -> list[dict[str, Any]]:
    """Return a compact summary of every opening for the picker UI."""
    progress = users.get_openings_progress(client_id) if client_id else {}
    out: list[dict[str, Any]] = []
    for o in _load_openings():
        rec = progress.get(str(o.get("id"))) or {}
        attempts = int(rec.get("drill_attempts") or 0)
        solved = int(rec.get("drill_solved") or 0)
        accuracy = (solved / attempts * 100.0) if attempts else 0.0
        out.append(
            {
                "id": o.get("id"),
                "name": o.get("name"),
                "eco": o.get("eco"),
                "side": o.get("side"),
                "description": o.get("description"),
                "moves_summary": " ".join(
                    str(m.get("san") or m.get("move") or "")
                    for m in (o.get("lines", [{}])[0].get("moves") or [])[:6]
                ),
                "lines_count": len(o.get("lines") or []),
                "drill_attempts": attempts,
                "drill_solved": solved,
                "accuracy": round(accuracy, 1),
                "best_streak": int(rec.get("best_streak") or 0),
                "theory_seen": bool(rec.get("theory_seen")),
            }
        )
    return out


def get_opening(opening_id: str, client_id: str | None = None) -> dict[str, Any] | None:
    """Return the full opening payload (theory + every line + commentary)."""
    for o in _load_openings():
        if str(o.get("id")) == str(opening_id):
            payload = dict(o)
            if client_id:
                progress = users.get_openings_progress(client_id) or {}
                payload["progress"] = progress.get(str(opening_id)) or {}
            return payload
    return None


def record_drill(
    client_id: str,
    *,
    opening_id: str,
    solved: int,
    failed: int,
    streak: int,
    duration_ms: int,
) -> dict[str, Any] | None:
    return users.record_opening_drill(
        client_id,
        opening_id=opening_id,
        solved=int(solved),
        failed=int(failed),
        streak=int(streak),
        duration_ms=int(duration_ms),
    )


def mark_theory_seen(client_id: str, opening_id: str) -> None:
    users.mark_opening_theory_seen(client_id, opening_id)
