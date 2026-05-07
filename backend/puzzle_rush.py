"""Puzzle Rush — timed / survival tactical-puzzle sprints.

Three modes:

  • ``3min`` and ``5min`` — classic chess.com-style: solve as many puzzles as
    you can before the clock runs out. Wrong answers count as misses but
    don't end the run.
  • ``survival`` — no clock; the run ends after the third miss.

The whole session is held in process memory (``_SESSIONS``). A run is
small (a few hundred attempts at most) and survives for two hours so a
client that disconnects briefly can resume; we GC stale rooms in
``reap_idle``.

Score is the sum of solved-puzzle ratings, mirroring chess.com's "1
point per solve" but scaled by puzzle difficulty so cracking a 2200
puzzle is worth more than three 800-rated ones.
"""
from __future__ import annotations

import secrets
import time
from dataclasses import dataclass, field
from threading import Lock
from typing import Any

import chess

from . import puzzles as puzzle_pack
from . import users as users_db

# Allowed (mode, duration_sec) pairs. ``survival`` has no wall-clock
# deadline server-side; we still timestamp the run so we can compute
# duration_ms in the final summary.
MODE_DURATION_SEC: dict[str, int | None] = {
    "3min": 3 * 60,
    "5min": 5 * 60,
    "survival": None,
}
SURVIVAL_MAX_MISTAKES = 3
# Each session pre-samples this many puzzles — even the world's fastest
# 5-min sprint can't crack more than a couple hundred. Keeps the SQLite
# round-trip count to one per session.
SESSION_QUEUE_SIZE = 400
# Tuning: how aggressively the puzzle bank ramps up as the player gets
# further into the run. Each solve advances the rating window by this
# many points so the run gets harder fast (the late game should mirror
# chess.com's near-impossible end). Floored / capped to keep the band
# inside the puzzle bank's reasonable range.
RATING_RAMP_PER_SOLVE = 25
MIN_BAND_RATING = 600
MAX_BAND_RATING = 2800
# Run lifetime in process memory once finished — kept around briefly
# so the client can re-fetch the final summary after a refresh.
RUN_TTL_SEC = 2 * 3600


@dataclass
class RushPuzzleEntry:  # noqa: E302
    """Recorded outcome of a single puzzle in a Rush run."""
    puzzle_id: str
    rating: int
    outcome: str  # "solved" | "failed" | "skipped"
    solve_ms: int


@dataclass
class RushSession:
    session_id: str
    client_id: str
    mode: str
    start_rating: int
    started_at: float
    duration_sec: int | None  # None for survival
    queue: list[dict[str, Any]] = field(default_factory=list)
    cursor: int = 0
    current: dict[str, Any] | None = None
    current_started_at: float = 0.0
    score: int = 0
    solved: int = 0
    mistakes: int = 0
    skipped: int = 0
    log: list[RushPuzzleEntry] = field(default_factory=list)
    finished: bool = False
    finished_at: float = 0.0
    finalized_summary: dict[str, Any] | None = None

    def time_left_ms(self) -> int | None:
        if self.duration_sec is None:
            return None
        elapsed = time.monotonic() - self.started_at
        return max(0, int((self.duration_sec - elapsed) * 1000))

    def time_expired(self) -> bool:
        if self.duration_sec is None:
            return False
        return (time.monotonic() - self.started_at) >= self.duration_sec


# Process-wide session registry. Rush is single-process so a plain
# dict guarded by a Lock is enough.
_SESSIONS: dict[str, RushSession] = {}
_LOCK = Lock()


def _puzzle_payload(p: dict[str, Any]) -> dict[str, Any]:
    """Reduced payload sent to the client per puzzle."""
    fen = str(p.get("fen") or "")
    side_to_solve: str | None = None
    try:
        board = chess.Board(fen)
        side_to_solve = "b" if board.turn == chess.WHITE else "w"
    except ValueError:
        pass
    return {
        "id": str(p.get("id") or ""),
        "fen": fen,
        "moves": list(p.get("moves") or []),
        "rating": int(p.get("rating") or 1200),
        "themes": list(p.get("themes") or []),
        "url": p.get("url"),
        "side_to_solve": side_to_solve,
    }


def _new_session_id() -> str:
    while True:
        sid = secrets.token_urlsafe(8)
        if sid not in _SESSIONS:
            return sid


def _build_queue(start_rating: int) -> list[dict[str, Any]]:
    """Pre-sample a queue that ramps from ``start_rating-200`` upward.

    Strategy: we pull a window-sized batch from the puzzle bank centred
    near the user's rating, then a wider sweep up to a hard puzzle, and
    interleave so the first puzzles are gentle and the queue gets harder
    as the run progresses. Any extra is shuffled in by the caller's
    ``cursor`` walk; we don't need a perfect ramp.
    """
    base = max(MIN_BAND_RATING, min(MAX_BAND_RATING, int(start_rating)))
    bands: list[tuple[int, int]] = []
    # Three nested bands: easy / target / stretch. Sum capped at SESSION_QUEUE_SIZE.
    bands.append((max(MIN_BAND_RATING, base - 250), base + 50))
    bands.append((max(MIN_BAND_RATING, base - 50), base + 350))
    bands.append((max(MIN_BAND_RATING, base + 200), min(MAX_BAND_RATING, base + 700)))
    pool: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    per_band = SESSION_QUEUE_SIZE // len(bands)
    for lo, hi in bands:
        rows = puzzle_pack.filter_puzzles(min_rating=lo, max_rating=hi)
        # SQLite gives us everything in a band; pick a small random
        # sample. JSON fallback already returns a small set.
        if len(rows) > per_band:
            # Stride sample without random module to keep order stable
            # for tests; we shuffle bands at the end anyway.
            step = max(1, len(rows) // per_band)
            rows = rows[::step][:per_band]
        for r in rows:
            pid = str(r.get("id") or "")
            if pid and pid not in seen_ids:
                seen_ids.add(pid)
                pool.append(r)
    if not pool:
        # If the bank is missing entirely (e.g. unit tests with empty
        # JSON pack) fall back to a generic sample so the API stays
        # functional.
        pool = puzzle_pack.sample_puzzles(SESSION_QUEUE_SIZE)
    pool.sort(key=lambda r: int(r.get("rating") or 0))
    return pool


def _gc_finished_locked() -> None:
    cutoff = time.time() - RUN_TTL_SEC
    stale = [
        sid for sid, s in _SESSIONS.items()
        if s.finished and s.finished_at and s.finished_at < cutoff
    ]
    for sid in stale:
        _SESSIONS.pop(sid, None)


def start_session(*, client_id: str, mode: str) -> dict[str, Any]:
    """Create a new run for ``client_id`` and return the first puzzle."""
    if mode not in MODE_DURATION_SEC:
        raise ValueError(f"unknown mode: {mode}")
    user = users_db.get_user(client_id) or {}
    start_rating = int(user.get("rating") or 1200)
    queue = _build_queue(start_rating)
    if not queue:
        raise RuntimeError("no_puzzles_available")
    with _LOCK:
        _gc_finished_locked()
        sid = _new_session_id()
        sess = RushSession(
            session_id=sid,
            client_id=client_id,
            mode=mode,
            start_rating=start_rating,
            started_at=time.monotonic(),
            duration_sec=MODE_DURATION_SEC[mode],
            queue=queue,
        )
        _SESSIONS[sid] = sess
        first = sess.queue[0]
        sess.current = first
        sess.current_started_at = time.monotonic()
        return {
            "session_id": sid,
            "mode": sess.mode,
            "duration_sec": sess.duration_sec,
            "start_rating": sess.start_rating,
            "puzzle": _puzzle_payload(first),
            "score": 0,
            "solved": 0,
            "mistakes": 0,
            "max_mistakes": SURVIVAL_MAX_MISTAKES if mode == "survival" else None,
        }


def _select_next_puzzle(sess: RushSession) -> dict[str, Any] | None:
    """Pick the next puzzle from the queue.

    The queue is sorted by rating, so we use ``cursor`` as the nominal
    floor and bump it on every solve to ramp difficulty.
    """
    if not sess.queue:
        return None
    sess.cursor = max(sess.cursor, 0)
    if sess.cursor >= len(sess.queue):
        # Walked off the end — wrap and start from the top (extra-rare).
        sess.cursor = 0
    nxt = sess.queue[sess.cursor]
    return nxt


def _attempt_payload(sess: RushSession, *, finished: bool) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "session_id": sess.session_id,
        "score": sess.score,
        "solved": sess.solved,
        "mistakes": sess.mistakes,
        "skipped": sess.skipped,
        "time_left_ms": sess.time_left_ms(),
        "finished": finished,
    }
    if sess.duration_sec is not None:
        payload["duration_sec"] = sess.duration_sec
    if sess.mode == "survival":
        payload["max_mistakes"] = SURVIVAL_MAX_MISTAKES
    return payload


def attempt(
    *,
    session_id: str,
    client_id: str,
    puzzle_id: str,
    outcome: str,
    solve_ms: int,
) -> dict[str, Any]:
    """Record an attempt and (unless the run is over) advance to the next puzzle."""
    if outcome not in ("solved", "failed", "skipped"):
        raise ValueError("bad_outcome")
    with _LOCK:
        sess = _SESSIONS.get(session_id)
        if sess is None:
            raise KeyError("unknown_session")
        if sess.client_id != client_id:
            raise PermissionError("not_owner")
        if sess.finished:
            return {
                **_attempt_payload(sess, finished=True),
                "summary": sess.finalized_summary,
            }
        cur = sess.current
        cur_id = str(cur.get("id") or "") if cur else ""
        if cur is None or cur_id != puzzle_id:
            # Stale attempt for a puzzle we already rotated past.
            return {
                "stale": True,
                **_attempt_payload(sess, finished=False),
                "puzzle": _puzzle_payload(cur) if cur else None,
            }
        # Apply outcome.
        prev_rating = int(cur.get("rating") or 1200)
        if outcome == "solved":
            sess.solved += 1
            sess.score += prev_rating + max(0, 30 - max(0, solve_ms // 1000)) * 2
            # Bump cursor so subsequent puzzles tend to be harder than
            # the current one.
            sess.cursor = min(len(sess.queue) - 1, sess.cursor + 1)
        elif outcome == "failed":
            sess.mistakes += 1
        else:
            sess.skipped += 1
        sess.log.append(
            RushPuzzleEntry(
                puzzle_id=cur_id,
                rating=prev_rating,
                outcome=outcome,
                solve_ms=int(solve_ms) if outcome == "solved" else 0,
            )
        )
        # End conditions.
        time_up = sess.time_expired()
        survival_done = sess.mode == "survival" and sess.mistakes >= SURVIVAL_MAX_MISTAKES
        if time_up or survival_done:
            return _finalize_locked(sess, reason="time" if time_up else "mistakes")
        # Advance to next puzzle.
        nxt = _select_next_puzzle(sess)
        if nxt is None:
            return _finalize_locked(sess, reason="exhausted")
        sess.current = nxt
        sess.current_started_at = time.monotonic()
        return {
            **_attempt_payload(sess, finished=False),
            "puzzle": _puzzle_payload(nxt),
        }


def _finalize_locked(sess: RushSession, *, reason: str) -> dict[str, Any]:
    """Caller already holds ``_LOCK``."""
    sess.finished = True
    sess.finished_at = time.time()
    duration_ms = int((time.monotonic() - sess.started_at) * 1000)
    user_after = users_db.record_puzzle_rush_result(
        sess.client_id,
        mode=sess.mode,
        score=sess.score,
        solved=sess.solved,
        mistakes=sess.mistakes,
        duration_ms=duration_ms,
    ) or {}
    rush_meta = (user_after.get("puzzle_rush") or {}).get("best", {}).get(sess.mode) or {}
    summary = {
        "session_id": sess.session_id,
        "mode": sess.mode,
        "score": sess.score,
        "solved": sess.solved,
        "mistakes": sess.mistakes,
        "skipped": sess.skipped,
        "duration_ms": duration_ms,
        "reason": reason,
        "log": [
            {
                "puzzle_id": e.puzzle_id,
                "rating": e.rating,
                "outcome": e.outcome,
                "solve_ms": e.solve_ms,
            }
            for e in sess.log[-50:]
        ],
        "personal_best": int(rush_meta.get("best") or 0),
        "is_new_best": bool(sess.score and sess.score >= int(rush_meta.get("best") or 0)),
    }
    sess.finalized_summary = summary
    return {
        **_attempt_payload(sess, finished=True),
        "summary": summary,
    }


def finalize(*, session_id: str, client_id: str) -> dict[str, Any]:
    """Force-finalize a session (e.g. user pressed "End run")."""
    with _LOCK:
        sess = _SESSIONS.get(session_id)
        if sess is None:
            raise KeyError("unknown_session")
        if sess.client_id != client_id:
            raise PermissionError("not_owner")
        if sess.finished:
            return {
                **_attempt_payload(sess, finished=True),
                "summary": sess.finalized_summary,
            }
        return _finalize_locked(sess, reason="manual")


def get_state(*, session_id: str, client_id: str) -> dict[str, Any]:
    """Return the current state — useful for client reconnection."""
    with _LOCK:
        sess = _SESSIONS.get(session_id)
        if sess is None:
            raise KeyError("unknown_session")
        if sess.client_id != client_id:
            raise PermissionError("not_owner")
        if sess.finished:
            return {
                **_attempt_payload(sess, finished=True),
                "summary": sess.finalized_summary,
            }
        # Auto-advance if the clock ran out while the client was away.
        if sess.time_expired():
            return _finalize_locked(sess, reason="time")
        return {
            **_attempt_payload(sess, finished=False),
            "puzzle": _puzzle_payload(sess.current) if sess.current else None,
        }


def reset_for_tests() -> None:
    with _LOCK:
        _SESSIONS.clear()
