"""Lightweight per-user notification bus.

Used by the party-invite flow: when one user invites another into a
party, an :class:`Invitation` is created and pushed onto every queue
the target client has subscribed via SSE. The target's browser sees
the toast in real time and can accept/decline; the actual party WS
join still happens through the existing ``/api/party/ws/{code}``
endpoint.

The state lives in-process (dict + asyncio queues), matching the
rest of the backend. It evaporates on restart - that's fine for a
local server.
"""
from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

INVITE_TTL_SEC = 600  # 10 minutes
QUEUE_MAX = 64        # per-subscriber backlog cap


@dataclass
class Invitation:
    invite_id: str
    party_code: str
    party_id: str
    host_id: str
    host_nickname: str
    host_avatar: str
    target_id: str
    created_at: float
    status: str = "pending"  # pending | accepted | declined | expired

    def public(self) -> dict[str, Any]:
        return {
            "id": self.invite_id,
            "party_code": self.party_code,
            "party_id": self.party_id,
            "host_id": self.host_id,
            "host_nickname": self.host_nickname,
            "host_avatar": self.host_avatar,
            "target_id": self.target_id,
            "status": self.status,
            "created_at": int(self.created_at),
        }


@dataclass
class _Subscriber:
    client_id: str
    queue: asyncio.Queue[dict[str, Any]] = field(default_factory=asyncio.Queue)


_INVITES: dict[str, Invitation] = {}
_SUBSCRIBERS: dict[str, list[_Subscriber]] = {}
_LOCK = asyncio.Lock()


def _norm_avatar(s: Any) -> str:
    """Trim/bound an avatar string. Accepts a glyph (≤8 chars) or an
    uploaded-image URL (``/api/avatars/<cid>.png?v=...``, ≤256 chars).
    Truncated ``/api/...`` stubs from older clients fall back to ♟."""
    t = (s or "").strip() if isinstance(s, str) else ""
    if not t:
        return "♟"
    if t.startswith("/api/avatars/"):
        return t[:256]
    if t.startswith("/api/"):
        return "♟"
    return t[:8]


def _new_invite_id() -> str:
    while True:
        candidate = secrets.token_urlsafe(8)
        if candidate not in _INVITES:
            return candidate


def _reap() -> None:
    """Drop expired invitations - called on every read path."""
    now = time.time()
    drop: list[str] = []
    for invite_id, inv in _INVITES.items():
        if now - inv.created_at > INVITE_TTL_SEC and inv.status == "pending":
            inv.status = "expired"
        if now - inv.created_at > INVITE_TTL_SEC * 2:
            drop.append(invite_id)
    for invite_id in drop:
        _INVITES.pop(invite_id, None)


async def _push(client_id: str, payload: dict[str, Any]) -> None:
    """Fan an event out to every active subscriber of ``client_id``."""
    subs = _SUBSCRIBERS.get(client_id) or []
    dead: list[_Subscriber] = []
    for sub in subs:
        try:
            sub.queue.put_nowait(payload)
        except asyncio.QueueFull:
            # Drop the oldest message and retry once. Backlog past
            # QUEUE_MAX means the browser is too slow, force a flush.
            try:
                sub.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                sub.queue.put_nowait(payload)
            except asyncio.QueueFull:
                dead.append(sub)
    if dead:
        for s in dead:
            try:
                _SUBSCRIBERS[client_id].remove(s)
            except (KeyError, ValueError):
                pass


async def create_invitation(
    *,
    host_id: str,
    host_nickname: str,
    host_avatar: str,
    target_id: str,
    party_code: str,
    party_id: str,
) -> Invitation:
    """Record a host's invite of ``target_id`` into a specific party."""
    if host_id == target_id:
        raise ValueError("cannot invite yourself")
    async with _LOCK:
        _reap()
        # Idempotent: if the same host already invited this target into
        # the same party and the invitation is still pending, return it
        # instead of stacking duplicates in the toast feed.
        for existing in _INVITES.values():
            if (
                existing.host_id == host_id
                and existing.target_id == target_id
                and existing.party_code == party_code
                and existing.status == "pending"
            ):
                return existing
        inv = Invitation(
            invite_id=_new_invite_id(),
            party_code=party_code,
            party_id=party_id,
            host_id=host_id,
            host_nickname=host_nickname[:32] or "Гость",
            host_avatar=_norm_avatar(host_avatar),
            target_id=target_id,
            created_at=time.time(),
        )
        _INVITES[inv.invite_id] = inv
    await _push(target_id, {"type": "invitation", "invitation": inv.public()})
    return inv


async def decline_invitation(invite_id: str, by_client_id: str) -> Invitation | None:
    async with _LOCK:
        inv = _INVITES.get(invite_id)
        if inv is None or inv.target_id != by_client_id:
            return None
        if inv.status == "pending":
            inv.status = "declined"
    await _push(inv.host_id, {"type": "invitation_declined", "invitation": inv.public()})
    return inv


async def accept_invitation(invite_id: str, by_client_id: str) -> Invitation | None:
    async with _LOCK:
        inv = _INVITES.get(invite_id)
        if inv is None or inv.target_id != by_client_id:
            return None
        if inv.status == "pending":
            inv.status = "accepted"
    await _push(inv.host_id, {"type": "invitation_accepted", "invitation": inv.public()})
    return inv


def pending_invitations_for(client_id: str) -> list[dict[str, Any]]:
    _reap()
    rows = [inv for inv in _INVITES.values() if inv.target_id == client_id and inv.status == "pending"]
    rows.sort(key=lambda x: x.created_at, reverse=True)
    return [inv.public() for inv in rows]


def get_invitation(invite_id: str) -> Invitation | None:
    return _INVITES.get(invite_id)


async def broadcast(payload: dict[str, Any]) -> None:
    """Fan ``payload`` out to every active SSE subscriber, regardless
    of client_id. Used for server-wide announcements such as engine
    configuration changes pushed by the host.
    """
    async with _LOCK:
        subs = [s for lst in _SUBSCRIBERS.values() for s in lst]
    for sub in subs:
        try:
            sub.queue.put_nowait(payload)
        except asyncio.QueueFull:
            try:
                sub.queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                sub.queue.put_nowait(payload)
            except asyncio.QueueFull:
                # Best-effort — if the queue is still full after a
                # forced flush, drop the message for this subscriber.
                pass


async def subscribe(client_id: str) -> _Subscriber:
    """Register a new SSE subscriber. Caller must call :func:`unsubscribe`."""
    sub = _Subscriber(client_id=client_id, queue=asyncio.Queue(maxsize=QUEUE_MAX))
    async with _LOCK:
        _SUBSCRIBERS.setdefault(client_id, []).append(sub)
    return sub


async def unsubscribe(sub: _Subscriber) -> None:
    async with _LOCK:
        try:
            _SUBSCRIBERS[sub.client_id].remove(sub)
            if not _SUBSCRIBERS[sub.client_id]:
                _SUBSCRIBERS.pop(sub.client_id, None)
        except (KeyError, ValueError):
            pass


def reset_for_tests() -> None:
    _INVITES.clear()
    _SUBSCRIBERS.clear()
