"""1 vs 1 mode — challenges + live legal-move match relay.

The 1 vs 1 view lets two visitors play a real chess game against each
other (legal moves, time control). The flow is:

1. Both clients open the 1 vs 1 tab and the frontend subscribes to the
   existing notification SSE pipe so it can receive challenges.
2. Player A picks player B from the online list, picks a time control
   (e.g. 5 min) and sends a challenge via ``POST /api/onevsone/challenge``.
   This persists a :class:`Challenge` record in-memory and pushes a
   ``onevsone_challenge`` notification onto B's queue.
3. Player B sees a bottom-right toast with Accept / Decline. On accept
   we mint a :class:`Match` (fresh chess.com-style FEN, random colours,
   the chosen time control) and push ``onevsone_match`` to both peers.
4. Each peer connects to ``/api/onevsone/ws?match_id=…&client_id=…``.
   Moves are validated server-side via python-chess and broadcast to
   the opposite peer along with the resulting FEN, last-move squares
   and remaining clocks.

Everything lives in-memory — same volatility model as ``party.py`` and
``presence.py``. A fresh server has no challenges and no matches.
"""
from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

import chess

from . import notifications as notifications_db

CHALLENGE_TTL_SEC = 120         # 2 minutes for the target to accept
MATCH_IDLE_TTL_SEC = 60 * 60    # drop idle matches after 1h


@dataclass
class Challenge:
    challenge_id: str
    challenger_id: str
    challenger_nickname: str
    challenger_avatar: str
    target_id: str
    target_nickname: str
    time_seconds: int           # base time per side
    increment_seconds: int      # Fischer increment per move
    created_at: float
    status: str = "pending"     # pending | accepted | declined | expired | cancelled
    # Challenger's preferred colour: "w" | "b" | "random". "random"
    # makes the server flip a coin at accept time so neither side
    # has a permanent edge.
    challenger_color: str = "random"

    def public(self) -> dict[str, Any]:
        return {
            "id": self.challenge_id,
            "challenger_id": self.challenger_id,
            "challenger_nickname": self.challenger_nickname,
            "challenger_avatar": self.challenger_avatar,
            "target_id": self.target_id,
            "target_nickname": self.target_nickname,
            "time_seconds": self.time_seconds,
            "increment_seconds": self.increment_seconds,
            "created_at": int(self.created_at),
            "status": self.status,
            "challenger_color": self.challenger_color,
        }


@dataclass
class Player:
    client_id: str
    nickname: str
    avatar: str
    color: str  # "w" | "b"
    clock_remaining: float


@dataclass
class Match:
    match_id: str
    white: Player
    black: Player
    time_seconds: int
    increment_seconds: int
    created_at: float
    last_move_at: float
    chess: chess.Board = field(default_factory=chess.Board)
    move_history: list[dict[str, Any]] = field(default_factory=list)
    finished: bool = False
    finish_reason: str = ""
    winner: str = ""  # "w" | "b" | "draw" | ""
    # client_id of the player who currently has an outstanding draw
    # offer pending. Empty when no offer is on the table. Cleared on
    # accept/decline and on every move (a fresh move auto-cancels the
    # offer to mirror chess.com behaviour).
    draw_offer_by: str = ""
    # Live WS sockets per client_id (one per side, additional spectators
    # could be supported later but aren't right now).
    sockets: dict[str, Any] = field(default_factory=dict)

    def opponent_of(self, client_id: str) -> Player | None:
        if self.white.client_id == client_id:
            return self.black
        if self.black.client_id == client_id:
            return self.white
        return None

    def player_for(self, client_id: str) -> Player | None:
        if self.white.client_id == client_id:
            return self.white
        if self.black.client_id == client_id:
            return self.black
        return None

    def public(self, viewer_id: str) -> dict[str, Any]:
        me = self.player_for(viewer_id)
        opp = self.opponent_of(viewer_id)
        return {
            "id": self.match_id,
            "fen": self.chess.fen(),
            "turn": "w" if self.chess.turn else "b",
            "you": _player_public(me) if me else None,
            "opponent": _player_public(opp) if opp else None,
            "white": _player_public(self.white),
            "black": _player_public(self.black),
            "time_seconds": self.time_seconds,
            "increment_seconds": self.increment_seconds,
            "history": list(self.move_history),
            "finished": self.finished,
            "finish_reason": self.finish_reason,
            "winner": self.winner,
            "draw_offer_by": self.draw_offer_by,
            "started_at": int(self.created_at),
        }


def _player_public(p: Player | None) -> dict[str, Any] | None:
    if p is None:
        return None
    return {
        "client_id": p.client_id,
        "nickname": p.nickname,
        "avatar": p.avatar,
        "color": p.color,
        "clock_remaining": round(p.clock_remaining, 2),
    }


_CHALLENGES: dict[str, Challenge] = {}
_MATCHES: dict[str, Match] = {}
_LOCK = asyncio.Lock()


def _new_id(prefix: str, registry: dict[str, Any]) -> str:
    while True:
        cand = f"{prefix}_{secrets.token_urlsafe(8)}"
        if cand not in registry:
            return cand


def _reap() -> None:
    now = time.time()
    drop_ch: list[str] = []
    for cid, c in _CHALLENGES.items():
        if c.status == "pending" and now - c.created_at > CHALLENGE_TTL_SEC:
            c.status = "expired"
        if now - c.created_at > CHALLENGE_TTL_SEC * 4:
            drop_ch.append(cid)
    for cid in drop_ch:
        _CHALLENGES.pop(cid, None)
    drop_m: list[str] = []
    for mid, m in _MATCHES.items():
        if m.finished and now - m.last_move_at > MATCH_IDLE_TTL_SEC:
            drop_m.append(mid)
    for mid in drop_m:
        _MATCHES.pop(mid, None)


async def create_challenge(
    *,
    challenger_id: str,
    challenger_nickname: str,
    challenger_avatar: str,
    target_id: str,
    target_nickname: str,
    time_seconds: int,
    increment_seconds: int = 0,
    challenger_color: str = "random",
) -> Challenge:
    if challenger_id == target_id:
        raise ValueError("cannot challenge yourself")
    time_seconds = max(10, min(int(time_seconds or 0), 60 * 60))
    increment_seconds = max(0, min(int(increment_seconds or 0), 60))
    cc = (challenger_color or "random").lower().strip()
    if cc not in ("w", "b", "random"):
        cc = "random"
    async with _LOCK:
        _reap()
        # Idempotent: collapse repeated identical pending challenges.
        for existing in _CHALLENGES.values():
            if (
                existing.status == "pending"
                and existing.challenger_id == challenger_id
                and existing.target_id == target_id
                and existing.time_seconds == time_seconds
                and existing.increment_seconds == increment_seconds
                and existing.challenger_color == cc
            ):
                return existing
        ch = Challenge(
            challenge_id=_new_id("ovo", _CHALLENGES),
            challenger_id=challenger_id,
            challenger_nickname=(challenger_nickname or "Гость")[:32],
            challenger_avatar=notifications_db._norm_avatar(challenger_avatar),
            target_id=target_id,
            target_nickname=(target_nickname or "Гость")[:32],
            time_seconds=time_seconds,
            increment_seconds=increment_seconds,
            created_at=time.time(),
            challenger_color=cc,
        )
        _CHALLENGES[ch.challenge_id] = ch
    await notifications_db._push(
        target_id,
        {"type": "onevsone_challenge", "challenge": ch.public()},
    )
    return ch


async def cancel_challenge(challenge_id: str, by_client_id: str) -> Challenge | None:
    async with _LOCK:
        ch = _CHALLENGES.get(challenge_id)
        if ch is None or ch.challenger_id != by_client_id:
            return None
        if ch.status == "pending":
            ch.status = "cancelled"
    await notifications_db._push(
        ch.target_id,
        {"type": "onevsone_challenge_cancelled", "challenge": ch.public()},
    )
    return ch


async def decline_challenge(challenge_id: str, by_client_id: str) -> Challenge | None:
    async with _LOCK:
        ch = _CHALLENGES.get(challenge_id)
        if ch is None or ch.target_id != by_client_id:
            return None
        if ch.status == "pending":
            ch.status = "declined"
    await notifications_db._push(
        ch.challenger_id,
        {"type": "onevsone_challenge_declined", "challenge": ch.public()},
    )
    return ch


async def accept_challenge(
    challenge_id: str,
    by_client_id: str,
    by_nickname: str,
    by_avatar: str,
) -> tuple[Challenge, Match] | None:
    async with _LOCK:
        ch = _CHALLENGES.get(challenge_id)
        if ch is None or ch.target_id != by_client_id:
            return None
        if ch.status != "pending":
            return None
        ch.status = "accepted"
        # Honour the challenger's stated preference; "random" flips a
        # coin so neither side has a permanent edge.
        if ch.challenger_color == "w":
            challenger_white = True
        elif ch.challenger_color == "b":
            challenger_white = False
        else:
            challenger_white = secrets.choice([True, False])
        if challenger_white:
            white = Player(
                client_id=ch.challenger_id,
                nickname=ch.challenger_nickname,
                avatar=ch.challenger_avatar,
                color="w",
                clock_remaining=float(ch.time_seconds),
            )
            black = Player(
                client_id=by_client_id,
                nickname=(by_nickname or ch.target_nickname)[:32] or "Гость",
                avatar=notifications_db._norm_avatar(by_avatar),
                color="b",
                clock_remaining=float(ch.time_seconds),
            )
        else:
            white = Player(
                client_id=by_client_id,
                nickname=(by_nickname or ch.target_nickname)[:32] or "Гость",
                avatar=notifications_db._norm_avatar(by_avatar),
                color="w",
                clock_remaining=float(ch.time_seconds),
            )
            black = Player(
                client_id=ch.challenger_id,
                nickname=ch.challenger_nickname,
                avatar=ch.challenger_avatar,
                color="b",
                clock_remaining=float(ch.time_seconds),
            )
        match = Match(
            match_id=_new_id("ovm", _MATCHES),
            white=white,
            black=black,
            time_seconds=ch.time_seconds,
            increment_seconds=ch.increment_seconds,
            created_at=time.time(),
            last_move_at=time.time(),
        )
        _MATCHES[match.match_id] = match
    # Push match info to BOTH peers so each side can navigate to the live
    # game. The notifications SSE pipe is the only "always on" channel
    # we have for users that haven't opened the 1v1 WS yet.
    payload_for_challenger = {
        "type": "onevsone_match",
        "challenge": ch.public(),
        "match": match.public(ch.challenger_id),
    }
    payload_for_target = {
        "type": "onevsone_match",
        "challenge": ch.public(),
        "match": match.public(ch.target_id),
    }
    await notifications_db._push(ch.challenger_id, payload_for_challenger)
    await notifications_db._push(ch.target_id, payload_for_target)
    return ch, match


def get_match(match_id: str) -> Match | None:
    return _MATCHES.get(match_id)


def get_challenge(challenge_id: str) -> Challenge | None:
    return _CHALLENGES.get(challenge_id)


def pending_challenges_for(client_id: str) -> list[dict[str, Any]]:
    _reap()
    rows = [
        c for c in _CHALLENGES.values()
        if c.target_id == client_id and c.status == "pending"
    ]
    rows.sort(key=lambda x: x.created_at, reverse=True)
    return [c.public() for c in rows]


async def attach_socket(match_id: str, client_id: str, ws: Any) -> Match | None:
    async with _LOCK:
        m = _MATCHES.get(match_id)
        if m is None:
            return None
        if m.player_for(client_id) is None:
            return None
        m.sockets[client_id] = ws
        return m


async def detach_socket(match_id: str, client_id: str) -> None:
    async with _LOCK:
        m = _MATCHES.get(match_id)
        if m is None:
            return
        if m.sockets.get(client_id) is not None:
            m.sockets.pop(client_id, None)


async def apply_move(
    match_id: str,
    client_id: str,
    uci: str,
) -> dict[str, Any] | None:
    async with _LOCK:
        m = _MATCHES.get(match_id)
        if m is None or m.finished:
            return None
        me = m.player_for(client_id)
        if me is None:
            return None
        # Enforce turn ownership.
        side = "w" if m.chess.turn else "b"
        if side != me.color:
            return {"error": "not_your_turn"}
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            return {"error": "bad_uci"}
        if move not in m.chess.legal_moves:
            return {"error": "illegal"}
        san = m.chess.san(move)
        is_capture = m.chess.is_capture(move)
        m.chess.push(move)
        now = time.time()
        # Subtract elapsed clock from the side that just moved, then add
        # the increment. Opponent's clock doesn't tick until they move.
        elapsed = now - m.last_move_at
        me.clock_remaining = max(0.0, me.clock_remaining - elapsed) + float(m.increment_seconds)
        m.last_move_at = now
        m.move_history.append({
            "uci": uci,
            "san": san,
            "from": chess.square_name(move.from_square),
            "to": chess.square_name(move.to_square),
            "by": me.color,
            "capture": is_capture,
            "fen_after": m.chess.fen(),
            "ts": int(now),
        })
        # Any move auto-revokes a pending draw offer (chess.com rule).
        m.draw_offer_by = ""
        # Game termination?
        if m.chess.is_checkmate():
            m.finished = True
            m.finish_reason = "checkmate"
            m.winner = me.color
        elif m.chess.is_stalemate():
            m.finished = True
            m.finish_reason = "stalemate"
            m.winner = "draw"
        elif m.chess.is_insufficient_material():
            m.finished = True
            m.finish_reason = "insufficient_material"
            m.winner = "draw"
        elif m.chess.can_claim_threefold_repetition() or m.chess.is_repetition(3):
            m.finished = True
            m.finish_reason = "repetition"
            m.winner = "draw"
        elif m.chess.can_claim_fifty_moves() or m.chess.halfmove_clock >= 100:
            m.finished = True
            m.finish_reason = "fifty_moves"
            m.winner = "draw"
        return {
            "ok": True,
            "san": san,
            "uci": uci,
            "from": chess.square_name(move.from_square),
            "to": chess.square_name(move.to_square),
            "fen": m.chess.fen(),
            "by": me.color,
            "turn": "w" if m.chess.turn else "b",
            "finished": m.finished,
            "finish_reason": m.finish_reason,
            "winner": m.winner,
            "history_len": len(m.move_history),
            "white_clock": round(m.white.clock_remaining, 2),
            "black_clock": round(m.black.clock_remaining, 2),
        }


def find_active_match(client_id: str) -> Match | None:
    """Return the first non-finished match ``client_id`` is a player in,
    or ``None``. Used by the active-match recovery endpoint so a user
    whose page reloaded mid-game can pick the match back up."""
    _reap()
    for m in _MATCHES.values():
        if m.finished:
            continue
        if m.player_for(client_id) is not None:
            return m
    return None


async def offer_draw(match_id: str, client_id: str) -> dict[str, Any] | None:
    async with _LOCK:
        m = _MATCHES.get(match_id)
        if m is None or m.finished:
            return None
        me = m.player_for(client_id)
        if me is None:
            return None
        if m.draw_offer_by == client_id:
            return {"ok": True, "already": True}
        m.draw_offer_by = client_id
        return {"ok": True, "by": client_id}


async def accept_draw(match_id: str, client_id: str) -> dict[str, Any] | None:
    async with _LOCK:
        m = _MATCHES.get(match_id)
        if m is None or m.finished:
            return None
        me = m.player_for(client_id)
        if me is None:
            return None
        if not m.draw_offer_by or m.draw_offer_by == client_id:
            return None
        m.finished = True
        m.finish_reason = "agreed_draw"
        m.winner = "draw"
        m.draw_offer_by = ""
        m.last_move_at = time.time()
        return {
            "ok": True,
            "finished": True,
            "finish_reason": "agreed_draw",
            "winner": "draw",
        }


async def decline_draw(match_id: str, client_id: str) -> dict[str, Any] | None:
    async with _LOCK:
        m = _MATCHES.get(match_id)
        if m is None or m.finished:
            return None
        me = m.player_for(client_id)
        if me is None:
            return None
        if not m.draw_offer_by or m.draw_offer_by == client_id:
            return None
        m.draw_offer_by = ""
        return {"ok": True, "declined_by": client_id}


async def resign(match_id: str, client_id: str) -> dict[str, Any] | None:
    async with _LOCK:
        m = _MATCHES.get(match_id)
        if m is None or m.finished:
            return None
        me = m.player_for(client_id)
        if me is None:
            return None
        m.finished = True
        m.finish_reason = "resign"
        m.winner = "b" if me.color == "w" else "w"
        m.last_move_at = time.time()
        return {
            "ok": True,
            "finished": True,
            "finish_reason": "resign",
            "winner": m.winner,
        }


def reset_for_tests() -> None:
    _CHALLENGES.clear()
    _MATCHES.clear()
