"""In-memory party / co-op puzzle rooms.

A party is a short-lived multiplayer session where every member walks
through the *same* shuffled puzzle queue for ten minutes — whoever
gets through more (and harder) puzzles wins. Score per puzzle is
``puzzle_rating + max(0, 30 - solve_seconds) * 2`` for a successful
solve (failures and skips score zero). The final ranking is written
into every participant's profile via :func:`users.record_party_result`.

The whole state lives in this process — restart wipes lobbies — which
matches the existing single-process backend. WebSocket clients hold
the live link; if a member drops the lobby keeps their seat for thirty
seconds so they can reconnect.
"""
from __future__ import annotations

import asyncio
import random
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

import chess
from fastapi import WebSocket

from . import puzzles as puzzle_pack
from . import users as users_db

PARTY_DURATION_SEC = 600
LOBBY_GRACE_SEC = 1800
RECONNECT_GRACE_SEC = 30
MAX_MEMBERS = 16
# How many puzzles each match samples up-front. With a 10-minute
# duration even the fastest solver rarely cracks more than a few hundred,
# so 1000 leaves plenty of headroom while keeping the queue cheap to
# build (one SQLite call) regardless of total bank size.
PARTY_QUEUE_SIZE = 1000

_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_PARTIES: dict[str, Party] = {}
_LOCK = asyncio.Lock()


def _new_code() -> str:
    while True:
        code = "".join(secrets.choice(_CODE_ALPHABET) for _ in range(6))
        if code not in _PARTIES:
            return code


def _puzzle_payload(p: dict[str, Any]) -> dict[str, Any]:
    fen = str(p.get("fen") or "")
    side_to_solve: str | None = None
    try:
        board = chess.Board(fen)
        side_to_solve = "b" if board.turn == chess.WHITE else "w"
    except ValueError:
        pass
    return {
        "id": p.get("id"),
        "fen": fen,
        "moves": list(p.get("moves") or []),
        "rating": int(p.get("rating") or 1200),
        "themes": list(p.get("themes") or []),
        "url": p.get("url"),
        "side_to_solve": side_to_solve,
    }


def _score_for(puzzle_rating: int, solve_ms: int) -> int:
    seconds = max(0, int(solve_ms) // 1000)
    bonus = max(0, 30 - seconds) * 2
    return int(puzzle_rating) + int(bonus)


@dataclass
class Member:
    client_id: str
    nickname: str
    avatar: str
    ws: WebSocket | None = None
    score: int = 0
    solved: int = 0
    failed: int = 0
    skipped: int = 0
    # Index into the party's shared puzzle queue. Each player advances
    # their own pointer when they finish a puzzle (solve / fail / skip),
    # so members work through the *same* shuffled list — whoever is
    # faster lands more attempts.
    puzzle_index: int = 0
    current_puzzle: dict[str, Any] | None = None
    current_started_at: float = 0.0
    last_solve_ms: int = 0
    disconnected_at: float | None = None
    is_host: bool = False


@dataclass
class Party:
    party_id: str
    code: str
    host_id: str
    created_at: float
    status: str = "lobby"  # lobby | playing | finished
    started_at: float = 0.0
    ends_at: float = 0.0
    members: dict[str, Member] = field(default_factory=dict)
    finish_task: asyncio.Task[None] | None = None
    finished_results: list[dict[str, Any]] = field(default_factory=list)
    # Shared, shuffled puzzle order for the whole match. Built in
    # `start()` from the entire pool, then re-used across every member.
    puzzle_queue: list[dict[str, Any]] = field(default_factory=list)

    def public_member(self, m: Member) -> dict[str, Any]:
        return {
            "client_id": m.client_id,
            "nickname": m.nickname,
            "avatar": m.avatar,
            "is_host": m.is_host,
            "score": m.score,
            "solved": m.solved,
            "failed": m.failed,
            "skipped": m.skipped,
            "online": m.ws is not None,
        }

    def public_state(self) -> dict[str, Any]:
        return {
            "party_id": self.party_id,
            "code": self.code,
            "host_id": self.host_id,
            "status": self.status,
            "started_at": int(self.started_at),
            "ends_at": int(self.ends_at),
            "duration_sec": PARTY_DURATION_SEC,
            "members": [self.public_member(m) for m in self.members.values()],
        }

    def scoreboard(self) -> list[dict[str, Any]]:
        rows = [self.public_member(m) for m in self.members.values()]
        rows.sort(key=lambda r: (-r["score"], -r["solved"], r["nickname"] or ""))
        return rows

    async def broadcast(self, payload: dict[str, Any]) -> None:
        dead: list[str] = []
        for cid, m in self.members.items():
            if m.ws is None:
                continue
            try:
                await m.ws.send_json(payload)
            except Exception:
                dead.append(cid)
        for cid in dead:
            await self._mark_disconnect(cid)

    async def _send(self, cid: str, payload: dict[str, Any]) -> None:
        m = self.members.get(cid)
        if not m or m.ws is None:
            return
        try:
            await m.ws.send_json(payload)
        except Exception:
            await self._mark_disconnect(cid)

    async def _mark_disconnect(self, cid: str) -> None:
        m = self.members.get(cid)
        if not m:
            return
        m.ws = None
        m.disconnected_at = time.time()

    def _next_puzzle_for(self, m: Member) -> dict[str, Any] | None:
        # Cycle the shared queue so a fast solver who exhausts it before
        # the timer ends keeps getting puzzles (in the same order — the
        # comparison stays fair because every member sees the same
        # rotation).
        if not self.puzzle_queue:
            return None
        p = self.puzzle_queue[m.puzzle_index % len(self.puzzle_queue)]
        m.puzzle_index += 1
        m.current_puzzle = p
        m.current_started_at = time.time()
        return p

    async def attach(
        self,
        client_id: str,
        nickname: str,
        avatar: str,
        ws: WebSocket,
    ) -> Member:
        existing = self.members.get(client_id)
        if existing is None:
            if len(self.members) >= MAX_MEMBERS:
                raise PartyError("party_full", "Party is full")
            if self.status != "lobby":
                raise PartyError("in_progress", "Party already started")
            existing = Member(
                client_id=client_id,
                nickname=nickname[:32] or "Гость",
                avatar=avatar[:8] or "♟",
                ws=ws,
                is_host=(client_id == self.host_id),
            )
            self.members[client_id] = existing
        else:
            existing.ws = ws
            existing.disconnected_at = None
            if nickname:
                existing.nickname = nickname[:32]
            if avatar:
                existing.avatar = avatar[:8]
        await self._send(client_id, {"type": "lobby", **self.public_state()})
        await self.broadcast({"type": "lobby", **self.public_state()})
        if self.status == "playing":
            await self._send(
                client_id,
                {
                    "type": "match_state",
                    "ends_at": int(self.ends_at),
                    "scoreboard": self.scoreboard(),
                    "your_puzzle": (
                        _puzzle_payload(existing.current_puzzle)
                        if existing.current_puzzle
                        else None
                    ),
                },
            )
            if existing.current_puzzle is None:
                p = self._next_puzzle_for(existing)
                if p is not None:
                    await self._send(
                        client_id,
                        {"type": "next_puzzle", "puzzle": _puzzle_payload(p)},
                    )
        elif self.status == "finished":
            await self._send(client_id, {"type": "finish", "results": self.finished_results})
        return existing

    async def detach(self, client_id: str) -> None:
        await self._mark_disconnect(client_id)
        await self.broadcast({"type": "lobby", **self.public_state()})

    async def start(self, by_client_id: str) -> None:
        if by_client_id != self.host_id:
            raise PartyError("not_host", "Only the host can start")
        if self.status != "lobby":
            raise PartyError("bad_status", "Party already started or finished")
        if not self.members:
            raise PartyError("empty", "No members")
        now = time.time()
        self.status = "playing"
        self.started_at = now
        self.ends_at = now + PARTY_DURATION_SEC
        # Sample a fresh queue from the puzzle bank for each match. Every
        # member walks through that same ordered list, so the comparison
        # is fair (same puzzles, same order); a different sample per match
        # keeps players from seeing identical openings. With the SQLite
        # bank backing 500k+ puzzles repeats inside a match are
        # essentially impossible.
        self.puzzle_queue = list(puzzle_pack.sample_puzzles(PARTY_QUEUE_SIZE))
        random.shuffle(self.puzzle_queue)
        for m in self.members.values():
            m.puzzle_index = 0
            p = self._next_puzzle_for(m)
            if p is not None:
                payload = _puzzle_payload(p)
                await self._send(
                    m.client_id,
                    {
                        "type": "start",
                        "started_at": int(self.started_at),
                        "ends_at": int(self.ends_at),
                        "your_puzzle": payload,
                    },
                )
        await self.broadcast(
            {
                "type": "scoreboard",
                "ends_at": int(self.ends_at),
                "scoreboard": self.scoreboard(),
            }
        )
        loop = asyncio.get_running_loop()
        self.finish_task = loop.create_task(self._finish_after())

    async def _finish_after(self) -> None:
        try:
            await asyncio.sleep(PARTY_DURATION_SEC)
        except asyncio.CancelledError:
            return
        await self.finish()

    async def attempt(
        self,
        client_id: str,
        *,
        puzzle_id: str,
        outcome: str,
        solve_ms: int,
    ) -> None:
        if self.status != "playing":
            return
        m = self.members.get(client_id)
        if m is None or m.current_puzzle is None:
            return
        if str(m.current_puzzle.get("id") or "") != puzzle_id:
            # Stale attempt (server already rotated puzzle); ignore.
            return
        if outcome == "solved":
            m.solved += 1
            m.last_solve_ms = int(solve_ms)
            m.score += _score_for(int(m.current_puzzle.get("rating") or 1200), int(solve_ms))
        elif outcome == "failed":
            m.failed += 1
        else:
            m.skipped += 1
        nxt = self._next_puzzle_for(m)
        if nxt is not None:
            await self._send(
                client_id,
                {"type": "next_puzzle", "puzzle": _puzzle_payload(nxt)},
            )
        await self.broadcast(
            {
                "type": "scoreboard",
                "ends_at": int(self.ends_at),
                "scoreboard": self.scoreboard(),
            }
        )

    async def finish(self) -> None:
        if self.status == "finished":
            return
        self.status = "finished"
        rows = self.scoreboard()
        results: list[dict[str, Any]] = []
        for rank, row in enumerate(rows, start=1):
            placement = rank
            participants = len(rows)
            party_elo = _party_elo_award(placement, participants, row["solved"], row["score"])
            entry = {
                "rank": rank,
                "client_id": row["client_id"],
                "nickname": row["nickname"],
                "avatar": row["avatar"],
                "score": row["score"],
                "solved": row["solved"],
                "failed": row["failed"],
                "skipped": row["skipped"],
                "party_elo": party_elo,
            }
            results.append(entry)
            try:
                users_db.record_party_result(
                    row["client_id"],
                    {
                        "party_id": self.party_id,
                        "placement": placement,
                        "participants": participants,
                        "solved": row["solved"],
                        "failed": row["failed"],
                        "skipped": row["skipped"],
                        "score": row["score"],
                        "elo_gained": party_elo,
                        "duration_sec": PARTY_DURATION_SEC,
                    },
                )
            except Exception:
                # Profile write failures shouldn't take the room down.
                pass
        self.finished_results = results
        await self.broadcast({"type": "finish", "results": results})


def _party_elo_award(placement: int, participants: int, solved: int, score: int) -> int:
    if participants <= 0 or solved == 0:
        return 0
    base = max(0, participants - placement + 1) * 5
    bonus = score // 100
    return int(base + bonus)


class PartyError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


async def create_party(host_id: str, host_nickname: str, host_avatar: str) -> Party:
    async with _LOCK:
        # Drop any stale/empty lobbies the host owned previously.
        for old in list(_PARTIES.values()):
            if old.status == "lobby" and not [m for m in old.members.values() if m.ws is not None]:
                if time.time() - old.created_at > LOBBY_GRACE_SEC:
                    _PARTIES.pop(old.code, None)
        code = _new_code()
        party = Party(
            party_id=secrets.token_hex(8),
            code=code,
            host_id=host_id,
            created_at=time.time(),
        )
        party.members[host_id] = Member(
            client_id=host_id,
            nickname=host_nickname[:32] or "Гость",
            avatar=host_avatar[:8] or "♟",
            ws=None,
            is_host=True,
        )
        _PARTIES[code] = party
        return party


def get_party(code: str) -> Party | None:
    return _PARTIES.get(code.upper())


def reap_idle() -> None:
    """Drop parties that have been finished or empty for too long."""
    now = time.time()
    drop: list[str] = []
    for code, p in _PARTIES.items():
        if p.status == "finished" and now - p.ends_at > 1800:
            drop.append(code)
        elif p.status == "lobby" and now - p.created_at > LOBBY_GRACE_SEC and all(
            m.ws is None for m in p.members.values()
        ):
            drop.append(code)
    for code in drop:
        _PARTIES.pop(code, None)


def reset_for_tests() -> None:
    """Test-only helper: drop the in-memory party registry."""
    _PARTIES.clear()
