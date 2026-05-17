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
import json
import logging
import os
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import chess

from . import notifications as notifications_db
from .settings import settings

logger = logging.getLogger(__name__)

CHALLENGE_TTL_SEC = 120         # 2 minutes for the target to accept
MATCH_IDLE_TTL_SEC = 60 * 60    # drop idle matches after 1h

# Disk path the in-memory match table is mirrored to after every
# state-changing operation. We rehydrate from this file on startup so
# a backend restart doesn't silently lose live games. Writes go through
# a tempfile + ``os.replace`` so a crash mid-write can't yield a
# truncated JSON.
_PERSIST_PATH: Path = settings.data_dir / "onevsone_matches.json"


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
# Lock guarding the on-disk JSON. We never want two flushes interleaving
# their tempfile -> rename dance, which would race on Windows.
_PERSIST_LOCK = asyncio.Lock()


def _player_to_dict(p: Player) -> dict[str, Any]:
    return {
        "client_id": p.client_id,
        "nickname": p.nickname,
        "avatar": p.avatar,
        "color": p.color,
        "clock_remaining": p.clock_remaining,
    }


def _player_from_dict(d: dict[str, Any]) -> Player:
    return Player(
        client_id=str(d.get("client_id", "")),
        nickname=str(d.get("nickname", "")),
        avatar=str(d.get("avatar", "")),
        color=str(d.get("color", "w")),
        clock_remaining=float(d.get("clock_remaining", 0.0)),
    )


def _match_to_dict(m: Match) -> dict[str, Any]:
    """Snapshot a Match into something JSON can hold.

    The chess.Board is stored as FEN — restoring from FEN drops the
    full move stack, but :attr:`Match.move_history` already carries
    every move played so the board can be reconstructed if we ever
    need to (currently we don't; the live UI replays from
    ``move_history`` and trusts ``board.fen()`` for the current
    position). We deliberately skip ``sockets`` — the live WS handles
    are reattached by clients after they reconnect.
    """
    return {
        "match_id": m.match_id,
        "white": _player_to_dict(m.white),
        "black": _player_to_dict(m.black),
        "time_seconds": m.time_seconds,
        "increment_seconds": m.increment_seconds,
        "created_at": m.created_at,
        "last_move_at": m.last_move_at,
        "fen": m.chess.fen(),
        "move_history": list(m.move_history),
        "finished": m.finished,
        "finish_reason": m.finish_reason,
        "winner": m.winner,
        "draw_offer_by": m.draw_offer_by,
    }


def _match_from_dict(d: dict[str, Any]) -> Match | None:
    """Rebuild a Match from its on-disk snapshot, or None if the row is
    corrupt / from a future schema we don't understand."""
    try:
        board = chess.Board(str(d["fen"]))
    except Exception:
        logger.warning("onevsone: dropping persisted match with bad FEN: %r", d.get("match_id"))
        return None
    try:
        return Match(
            match_id=str(d["match_id"]),
            white=_player_from_dict(d["white"]),
            black=_player_from_dict(d["black"]),
            time_seconds=int(d.get("time_seconds", 600)),
            increment_seconds=int(d.get("increment_seconds", 0)),
            created_at=float(d.get("created_at", time.time())),
            last_move_at=float(d.get("last_move_at", time.time())),
            chess=board,
            move_history=list(d.get("move_history", []) or []),
            finished=bool(d.get("finished", False)),
            finish_reason=str(d.get("finish_reason", "")),
            winner=str(d.get("winner", "")),
            draw_offer_by=str(d.get("draw_offer_by", "")),
        )
    except (KeyError, TypeError, ValueError) as exc:
        logger.warning("onevsone: dropping persisted match with bad shape: %s", exc)
        return None


async def _persist() -> None:
    """Atomically mirror ``_MATCHES`` to disk.

    Must be called from inside ``_LOCK``-protected sections (so the
    snapshot is consistent) or right after one releases. Drops finished
    matches that are past ``MATCH_IDLE_TTL_SEC`` from the snapshot — we
    don't want the JSON to grow unbounded.
    """
    snapshot = {
        mid: _match_to_dict(m)
        for mid, m in _MATCHES.items()
        # Don't bother persisting finished games — they live in memory
        # for the idle TTL window so users can replay/download PGN
        # immediately after the game, but a restart can drop them.
        if not m.finished
    }
    payload = {"version": 1, "matches": snapshot}
    async with _PERSIST_LOCK:
        try:
            _PERSIST_PATH.parent.mkdir(parents=True, exist_ok=True)
            tmp = _PERSIST_PATH.with_suffix(_PERSIST_PATH.suffix + ".tmp")
            data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
            await asyncio.to_thread(tmp.write_text, data, "utf-8")
            await asyncio.to_thread(os.replace, str(tmp), str(_PERSIST_PATH))
        except Exception:
            # Persistence failures must not break the game flow — log
            # and keep going. Worst case a crash loses the last few
            # moves, which is strictly better than crashing on disk-full.
            logger.exception("onevsone: failed to persist matches")


async def load_persisted() -> int:
    """Hydrate ``_MATCHES`` from the on-disk JSON. Returns the number
    of matches restored. Idempotent — safe to call multiple times.

    Called from the FastAPI lifespan startup so a server restart
    doesn't silently lose in-flight games. Clients still need to refresh
    + reattach their WS, which the frontend already does because the
    socket drops when the server goes away.
    """
    try:
        raw = await asyncio.to_thread(_PERSIST_PATH.read_text, "utf-8")
    except FileNotFoundError:
        return 0
    except Exception:
        logger.exception("onevsone: failed to read persisted matches")
        return 0
    try:
        payload = json.loads(raw)
    except Exception:
        logger.warning("onevsone: persisted file is not JSON, ignoring")
        return 0
    matches = (payload or {}).get("matches") or {}
    restored = 0
    async with _LOCK:
        for _mid, row in matches.items():
            if not isinstance(row, dict):
                continue
            m = _match_from_dict(row)
            if m is None:
                continue
            _MATCHES[m.match_id] = m
            restored += 1
    if restored:
        logger.info("onevsone: restored %d in-flight matches from disk", restored)
    return restored


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
    # Mirror to disk so a restart preserves the just-created game.
    await _persist()
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
    result: dict[str, Any] | None
    persist_needed = False
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
            # Tolerate stale clients that unconditionally append a "q"
            # promotion suffix to every move (a pre-fix bug in
            # ``tryOneVsOneMove``). For non-promotion pawn pushes
            # (e.g. ``e2e4q``) ``chess.Move.from_uci`` happily returns
            # a "promote to queen" move that fails ``is_legal`` on
            # rank 4 — which used to surface to the user as a piece
            # that "teleports back" because the WS error handler
            # refetches the authoritative pre-move snapshot. Strip
            # the trailing promotion and retry once before giving up,
            # so users on a cached pre-fix bundle aren't permanently
            # stuck.
            if move.promotion is not None and len(uci) >= 5:
                try:
                    fallback = chess.Move.from_uci(uci[:4])
                except ValueError:
                    fallback = None
                if fallback is not None and fallback in m.chess.legal_moves:
                    move = fallback
                    uci = uci[:4]
                else:
                    return {"error": "illegal"}
            else:
                return {"error": "illegal"}
        persist_needed = True
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
        result = {
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
    if persist_needed:
        await _persist()
    return result


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
    await _persist()
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
    await _persist()
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
    await _persist()
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
        winner = m.winner
    await _persist()
    return {
        "ok": True,
        "finished": True,
        "finish_reason": "resign",
        "winner": winner,
    }


def reset_for_tests() -> None:
    _CHALLENGES.clear()
    _MATCHES.clear()
