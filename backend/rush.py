"""Puzzle Rush — solve as many as you can in N minutes; one mistake ends it.

A rush session is a short-lived in-memory queue of puzzles served from
the SQLite bank. The server picks puzzles in ascending difficulty so
the first few are warm-ups and the bank gets brutal toward the end. A
single failed attempt or the timer running out finishes the session;
the user's best ``solved`` count per duration is persisted into their
profile via :func:`users.record_rush_session`.

State is process-local — a server restart drops live sessions, which is
fine for a co-op-friends backend. Sessions are reaped after twice the
duration so a client that abandons mid-rush doesn't leak memory.
"""
from __future__ import annotations

import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any

from . import puzzles, users

# Allowed Rush durations (sec). 3 / 5 minutes is the chess.com default.
RUSH_ALLOWED_DURATIONS_SEC: tuple[int, ...] = (180, 300)
# How many puzzles we pre-load. Even the fastest solver caps out around
# ~80 in 5 minutes, so 200 is plenty of headroom and keeps SQLite
# reads to one batched query per session.
RUSH_QUEUE_SIZE = 200
# Difficulty ramp: per-bucket slice counts (lo→hi). Solving past the
# end of the queue is impossible in practice; if it happens we cycle.
_RUSH_RATING_BUCKETS: tuple[tuple[int, int, int], ...] = (
    # (min_rating, max_rating, count)
    (700, 1100, 30),
    (1100, 1400, 50),
    (1400, 1700, 60),
    (1700, 2000, 40),
    (2000, 2400, 20),
)
_SESSION_GRACE_SEC = 60  # buffer past the timer for the final POST


@dataclass
class _RushSession:
    sid: str
    client_id: str
    duration_sec: int
    started_at: float
    ends_at: float
    queue: list[dict[str, Any]] = field(default_factory=list)
    cursor: int = 0
    solved: int = 0
    failed: int = 0
    finished: bool = False
    finished_at: float = 0.0
    # Fast lookup: puzzle_id → queue index, so the client can post
    # outcomes by id without us trusting a position counter.
    by_id: dict[str, int] = field(default_factory=dict)


_SESSIONS: dict[str, _RushSession] = {}
_LOCK = threading.Lock()


def _new_id() -> str:
    return secrets.token_urlsafe(12)


def _build_queue() -> list[dict[str, Any]]:
    """Pull a difficulty-sorted bag of puzzles for the rush ladder."""
    out: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for lo, hi, count in _RUSH_RATING_BUCKETS:
        for p in puzzles.sample_puzzles(count, min_rating=lo, max_rating=hi):
            pid = str(p.get("id") or "")
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            out.append(p)
    # If buckets undershot, top up with a wide-band sample.
    if len(out) < RUSH_QUEUE_SIZE:
        fill = puzzles.sample_puzzles(
            RUSH_QUEUE_SIZE - len(out),
            min_rating=700,
            max_rating=2400,
        )
        for p in fill:
            pid = str(p.get("id") or "")
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            out.append(p)
    return out[:RUSH_QUEUE_SIZE]


def _sanitize(p: dict[str, Any]) -> dict[str, Any]:
    moves = p.get("moves") or []
    if isinstance(moves, str):
        moves = moves.split()
    themes = p.get("themes") or []
    if isinstance(themes, str):
        themes = themes.split()
    return {
        "id": str(p.get("id") or ""),
        "fen": str(p.get("fen") or ""),
        "moves": list(moves),
        "rating": int(p.get("rating") or 1200),
        "themes": list(themes),
    }


def start(client_id: str, duration_sec: int) -> dict[str, Any] | None:
    """Begin a rush session. Returns the session id + first puzzle."""
    if not client_id:
        return None
    if int(duration_sec) not in RUSH_ALLOWED_DURATIONS_SEC:
        return None
    queue = _build_queue()
    if not queue:
        return None
    now = time.time()
    sid = _new_id()
    sess = _RushSession(
        sid=sid,
        client_id=client_id,
        duration_sec=int(duration_sec),
        started_at=now,
        ends_at=now + int(duration_sec),
        queue=queue,
        by_id={str(p.get("id") or ""): i for i, p in enumerate(queue)},
    )
    with _LOCK:
        _reap()
        _SESSIONS[sid] = sess
    return {
        "session_id": sid,
        "duration_sec": sess.duration_sec,
        "started_at": int(sess.started_at),
        "ends_at": int(sess.ends_at),
        "puzzle": _sanitize(queue[0]),
        "solved": 0,
        "failed": 0,
    }


def attempt(
    session_id: str,
    *,
    puzzle_id: str,
    outcome: str,
    solve_ms: int,
    played_moves: list[str] | None = None,
) -> dict[str, Any] | None:
    """Submit an attempt; returns next puzzle or finish summary.

    ``played_moves`` is server-validated against the canonical solution.
    A claim of ``solved`` with mismatched moves is coerced to ``failed``,
    which ends the session — cheaters get their rush ended just like
    everyone else.
    """
    with _LOCK:
        sess = _SESSIONS.get(session_id)
        if sess is None or sess.finished:
            return None
        idx = sess.by_id.get(puzzle_id)
        if idx is None or idx != sess.cursor:
            # Stale or out-of-order attempt — ignore.
            return None
        now = time.time()
        if now > sess.ends_at + _SESSION_GRACE_SEC:
            return _finish(sess, now)
        puzzle = sess.queue[idx]
        if outcome == "solved":
            expected = (puzzle.get("moves") or [])[1::2]
            if not _moves_match(played_moves or [], expected):
                outcome = "failed"
            elif int(solve_ms) < 100:
                outcome = "failed"
        if outcome == "solved":
            sess.solved += 1
            sess.cursor += 1
            if now > sess.ends_at:
                return _finish(sess, now)
            if sess.cursor >= len(sess.queue):
                # Cleared the queue — great rush. Finish out so the
                # leaderboard sees the result rather than ramping forever.
                return _finish(sess, now)
            nxt = sess.queue[sess.cursor]
            return {
                "session_id": sess.sid,
                "outcome": "solved",
                "solved": sess.solved,
                "failed": sess.failed,
                "ends_at": int(sess.ends_at),
                "puzzle": _sanitize(nxt),
                "finished": False,
            }
        # Any non-solved outcome (failed / timeout / cheat) ends the rush.
        sess.failed += 1
        return _finish(sess, now)


def status(session_id: str) -> dict[str, Any] | None:
    """Server-side timer probe. Auto-finishes if past the deadline."""
    with _LOCK:
        sess = _SESSIONS.get(session_id)
        if sess is None:
            return None
        now = time.time()
        if not sess.finished and now > sess.ends_at:
            return _finish(sess, now)
        return {
            "session_id": sess.sid,
            "solved": sess.solved,
            "failed": sess.failed,
            "ends_at": int(sess.ends_at),
            "finished": sess.finished,
        }


def _finish(sess: _RushSession, now: float) -> dict[str, Any]:
    if sess.finished:
        return _summary(sess)
    sess.finished = True
    sess.finished_at = now
    try:
        users.record_rush_session(
            sess.client_id,
            duration_sec=sess.duration_sec,
            solved=sess.solved,
            failed=sess.failed,
            started_at=int(sess.started_at),
            ended_at=int(now),
        )
    except Exception:  # noqa: BLE001 — recording must never break the API
        pass
    return _summary(sess)


def _summary(sess: _RushSession) -> dict[str, Any]:
    return {
        "session_id": sess.sid,
        "finished": True,
        "solved": sess.solved,
        "failed": sess.failed,
        "started_at": int(sess.started_at),
        "ended_at": int(sess.finished_at or sess.ends_at),
        "duration_sec": sess.duration_sec,
    }


def _moves_match(played: list[str], expected: list[str]) -> bool:
    """Same shape-checker as daily.py — server-authoritative move check."""
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


def _reap() -> None:
    """Drop sessions older than 2x duration so memory doesn't leak."""
    now = time.time()
    dead: list[str] = []
    for sid, sess in _SESSIONS.items():
        if sess.finished and now - sess.finished_at > 600:
            dead.append(sid)
            continue
        if not sess.finished and now > sess.ends_at + sess.duration_sec * 2:
            sess.finished = True
            sess.finished_at = now
            dead.append(sid)
    for sid in dead:
        _SESSIONS.pop(sid, None)


def leaderboard(duration_sec: int) -> list[dict[str, Any]]:
    return users.list_rush_leaderboard(duration_sec)


def reset_for_tests() -> None:
    with _LOCK:
        _SESSIONS.clear()
