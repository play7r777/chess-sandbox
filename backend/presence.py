"""Live presence registry for solo puzzle players.

Mirrors the spectator side of `party.py` but for users solving puzzles
*outside* a party — i.e. on their real ranked rating. Each connected
solo player owns a :class:`Presence` entry; spectators attach to a
specific player by ``client_id`` and receive that player's board /
cursor / selection updates in real time.

The registry is in-memory, single-process — same constraints as the
party module. It auto-evicts presences when the player's WebSocket
closes; spectators get a short ``presence_gone`` notice when their
target disappears.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket

from .party import (
    _sanitize_hex_color,
    _sanitize_piece_id,
    _sanitize_square,
    _sanitize_squares,
)


@dataclass
class Presence:
    """One active solo puzzle player. ``ws`` is the player's own
    socket; ``spectators`` is a {client_id: WebSocket} dict for users
    who have attached to watch this player."""

    client_id: str
    nickname: str
    avatar: str
    ws: WebSocket | None = None
    theme: str = ""
    pieces: str = ""
    legal_color: str = "#28c85a"
    rating: int = 0
    flipped: bool = False
    last_move: str = ""
    selection: dict[str, Any] | None = None
    current_fen: str = ""
    current_puzzle_id: str = ""
    current_puzzle_rating: int = 0
    streak: int = 0
    best_streak: int = 0
    started_at: float = field(default_factory=time.time)
    last_update: float = field(default_factory=time.time)
    spectators: dict[str, WebSocket] = field(default_factory=dict)


_PRESENCES: dict[str, Presence] = {}
_LOCK = asyncio.Lock()


def _public_state(p: Presence) -> dict[str, Any]:
    """Snapshot used both for the discovery list and as the initial
    ``presence_state`` payload sent to a new spectator."""
    return {
        "client_id": p.client_id,
        "nickname": p.nickname,
        "avatar": p.avatar,
        "theme": p.theme,
        "pieces": p.pieces,
        "legal_color": p.legal_color or "#28c85a",
        "rating": int(p.rating or 0),
        "flipped": bool(p.flipped),
        "last_move": p.last_move or "",
        "selection": p.selection,
        "fen": p.current_fen or "",
        "puzzle_id": p.current_puzzle_id or "",
        "puzzle_rating": int(p.current_puzzle_rating or 0),
        "streak": int(p.streak or 0),
        "best_streak": int(p.best_streak or 0),
        "started_at": int(p.started_at),
        "last_update": int(p.last_update),
    }


def list_active(max_idle_sec: float = 120.0) -> list[dict[str, Any]]:
    """Snapshot of currently-live solo players for the discovery list.

    Filters out entries whose websocket is already gone or who haven't
    sent any update in the last ``max_idle_sec`` seconds (so a tab
    that crashed without ``onclose`` doesn't haunt the list forever).
    """
    now = time.time()
    out: list[dict[str, Any]] = []
    for p in _PRESENCES.values():
        if p.ws is None:
            continue
        if now - p.last_update > max_idle_sec:
            continue
        out.append({
            "client_id": p.client_id,
            "nickname": p.nickname,
            "avatar": p.avatar,
            "rating": int(p.rating or 0),
            "puzzle_rating": int(p.current_puzzle_rating or 0),
            "streak": int(p.streak or 0),
            "best_streak": int(p.best_streak or 0),
            "spectator_count": len(p.spectators),
            "started_at": int(p.started_at),
        })
    # Most-recently-active first so people see the lively tables on top.
    out.sort(key=lambda r: int(r["started_at"]), reverse=True)
    return out


async def _broadcast_to_spectators(p: Presence, msg: dict[str, Any]) -> None:
    """Fan-out helper. Drops dead sockets quietly; we never raise out
    of a player's update path because a watcher disconnected."""
    if not p.spectators:
        return
    dead: list[str] = []
    for sid, ws in list(p.spectators.items()):
        try:
            await ws.send_json(msg)
        except Exception:
            dead.append(sid)
    for sid in dead:
        p.spectators.pop(sid, None)


async def attach_player(
    ws: WebSocket,
    *,
    client_id: str,
    nickname: str,
    avatar: str,
    theme: str = "",
    pieces: str = "",
    legal_color: str = "",
    rating: int = 0,
) -> Presence:
    """Register or refresh the calling user's solo presence. Replaces
    any previous WebSocket for the same ``client_id`` (player opened
    a second tab) so the most-recent connection wins."""
    async with _LOCK:
        existing = _PRESENCES.get(client_id)
        sanitized = _sanitize_hex_color(legal_color) if legal_color else ""
        if existing is None:
            existing = Presence(
                client_id=client_id,
                nickname=(nickname or "Гость")[:32],
                avatar=(avatar or "♟")[:8],
                ws=ws,
                theme=(theme or "")[:32],
                pieces=(pieces or "")[:32],
                legal_color=sanitized or "#28c85a",
                rating=max(0, int(rating or 0)),
            )
            _PRESENCES[client_id] = existing
        else:
            # Close the previous socket if it's still around — we only
            # want one player connection per client_id.
            old = existing.ws
            existing.ws = ws
            if nickname:
                existing.nickname = nickname[:32]
            if avatar:
                existing.avatar = avatar[:8]
            if theme:
                existing.theme = theme[:32]
            if pieces:
                existing.pieces = pieces[:32]
            if sanitized:
                existing.legal_color = sanitized
            if rating:
                existing.rating = max(0, int(rating or 0))
            existing.last_update = time.time()
            if old is not None and old is not ws:
                try:
                    await old.close()
                except Exception:
                    pass
        return existing


async def detach_player(client_id: str) -> None:
    """Player WebSocket closed. Drops the presence and notifies any
    attached spectators so their UI can fall back to the list view."""
    async with _LOCK:
        p = _PRESENCES.pop(client_id, None)
    if p is None:
        return
    p.ws = None
    await _broadcast_to_spectators(
        p, {"type": "presence_gone", "client_id": client_id},
    )
    for ws in list(p.spectators.values()):
        try:
            await ws.close()
        except Exception:
            pass
    p.spectators.clear()


async def attach_spectator(
    ws: WebSocket,
    *,
    spectator_id: str,
    target_client_id: str,
) -> Presence | None:
    """Subscribe a spectator websocket to a specific live player.
    Returns ``None`` if the target isn't online (the caller should
    send an error frame and close)."""
    async with _LOCK:
        p = _PRESENCES.get(target_client_id)
        if p is None or p.ws is None:
            return None
        p.spectators[spectator_id] = ws
    # Send initial state immediately so the spectator's mini-board
    # paints something the moment the WS opens — before the player's
    # next move/cursor frame.
    try:
        await ws.send_json({"type": "presence_state", **_public_state(p)})
    except Exception:
        async with _LOCK:
            p2 = _PRESENCES.get(target_client_id)
            if p2 is not None:
                p2.spectators.pop(spectator_id, None)
        return None
    return p


async def detach_spectator(target_client_id: str, spectator_id: str) -> None:
    async with _LOCK:
        p = _PRESENCES.get(target_client_id)
        if p is not None:
            p.spectators.pop(spectator_id, None)


async def update_position(
    client_id: str,
    fen: str,
    *,
    flipped: bool | None = None,
    last_move: str | None = None,
    puzzle_id: str | None = None,
    puzzle_rating: int | None = None,
    streak: int | None = None,
    best_streak: int | None = None,
    rating: int | None = None,
) -> None:
    p = _PRESENCES.get(client_id)
    if p is None:
        return
    p.current_fen = str(fen or "")
    if flipped is not None:
        p.flipped = bool(flipped)
    if last_move is not None:
        p.last_move = str(last_move or "")
    if puzzle_id is not None:
        p.current_puzzle_id = str(puzzle_id or "")[:64]
    if puzzle_rating is not None:
        try:
            p.current_puzzle_rating = max(0, int(puzzle_rating))
        except (TypeError, ValueError):
            pass
    if streak is not None:
        try:
            p.streak = max(0, int(streak))
        except (TypeError, ValueError):
            pass
    if best_streak is not None:
        try:
            p.best_streak = max(0, int(best_streak))
        except (TypeError, ValueError):
            pass
    if rating is not None:
        try:
            p.rating = max(0, int(rating))
        except (TypeError, ValueError):
            pass
    p.last_update = time.time()
    await _broadcast_to_spectators(
        p, {"type": "presence_state", **_public_state(p)},
    )


async def update_selection(
    client_id: str,
    *,
    from_sq: Any,
    piece: Any,
    legal_moves: Any,
    legal_captures: Any,
    legal_color: Any,
) -> None:
    p = _PRESENCES.get(client_id)
    if p is None:
        return
    sq = _sanitize_square(from_sq)
    if sq is None:
        if p.selection is None:
            return
        p.selection = None
    else:
        p.selection = {
            "from": sq,
            "piece": _sanitize_piece_id(piece),
            "legal_moves": _sanitize_squares(legal_moves),
            "legal_captures": _sanitize_squares(legal_captures),
        }
    col = _sanitize_hex_color(legal_color)
    if col:
        p.legal_color = col
    p.last_update = time.time()
    await _broadcast_to_spectators(
        p, {"type": "presence_state", **_public_state(p)},
    )


async def relay_cursor(
    client_id: str,
    x: float,
    y: float,
    *,
    flipped: bool = False,
    selected: str | None = None,
    dragging: bool = False,
    drag_piece: str | None = None,
    drag_from: str | None = None,
) -> None:
    p = _PRESENCES.get(client_id)
    if p is None or not p.spectators:
        # No-op when nobody's watching — skip the broadcast cost.
        if p is not None:
            p.last_update = time.time()
        return
    try:
        xv = max(-0.05, min(1.05, float(x)))
        yv = max(-0.05, min(1.05, float(y)))
    except (TypeError, ValueError):
        return
    p.last_update = time.time()
    await _broadcast_to_spectators(p, {
        "type": "presence_cursor",
        "client_id": p.client_id,
        "x": xv,
        "y": yv,
        "flipped": bool(flipped),
        "selected": _sanitize_square(selected) or "",
        "dragging": bool(dragging),
        "drag_piece": _sanitize_piece_id(drag_piece) or "",
        "drag_from": _sanitize_square(drag_from) or "",
    })
