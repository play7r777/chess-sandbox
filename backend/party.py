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
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

import chess
from fastapi import WebSocket

from . import puzzles as puzzle_pack
from . import users as users_db

# Match length is fixed at 3 min — chess.com Puzzle Battle style.
# We keep the tuple/constant so legacy WS payloads (older clients) that
# send `duration_sec` still validate, but only 180 is accepted.
PARTY_ALLOWED_DURATIONS_SEC: tuple[int, ...] = (180,)
PARTY_DURATION_SEC = 180
# How many wrong answers each player can stack before they're out. As
# soon as ANY player drains all of their lives the room finishes
# immediately and the current scoreboard becomes the result table.
PARTY_LIVES_PER_PLAYER = 3
# Number of cells per vertical column in the scoreboard's streak grid;
# matches the chess.com rendering. After every Nth solved/failed puzzle
# a fresh column opens to the right of the previous one.
PARTY_GRID_COL_HEIGHT = 10
LOBBY_GRACE_SEC = 1800
RECONNECT_GRACE_SEC = 30
MAX_MEMBERS = 30
# How many puzzles each match samples up-front. With a 10-minute
# duration even the fastest solver rarely cracks more than a few hundred,
# so 1000 leaves plenty of headroom while keeping the queue cheap to
# build (one SQLite call) regardless of total bank size.
PARTY_QUEUE_SIZE = 1000
# When picking a queue we pull puzzles within +-PARTY_BAND_HALF_WIDTH
# of the average lobby rating, so a lobby of 1200-rated players gets
# 1000-1400 puzzles instead of the bank's full spread. Tuned wide
# enough that small lobbies still see variety; narrow enough that
# beating beginners isn't the same as beating grandmasters.
PARTY_BAND_HALF_WIDTH = 350
PARTY_BAND_MIN = 600
PARTY_BAND_MAX = 2800
# Max attempts kept per player for the in-memory match log. A 10-min
# match maxes out at <300 attempts even for the fastest solvers, so
# 500 is a safe ceiling and keeps the per-room footprint bounded.
PARTY_MAX_ATTEMPT_LOG = 500
# Min interval between two consecutive player_state broadcasts for a
# given player. Spectators want the live board to mirror moves as soon
# as they happen, so we set this to 1ms — effectively no throttle.
# Position broadcasts only fire on actual board moves (one ws.send per
# legal move), so a 1ms floor is safe even with 16 simultaneous players.
PLAYER_STATE_THROTTLE_SEC = 0.001

_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
_PARTIES: dict[str, Party] = {}
_LOCK = asyncio.Lock()

_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")
_SQUARE_RE = re.compile(r"^[a-h][1-8]$")
_PIECE_RE = re.compile(r"^[wb][KQRBNP]$")


def _norm_avatar(s: Any) -> str:
    """Trim and bound the avatar string for in-memory party state.

    Mirrors :func:`backend.users._normalize_avatar` so a user with an
    uploaded photo (URL like ``/api/avatars/<cid>.png?v=...``) shows the
    full URL on the scoreboard / spectator list / invitation toast
    instead of being truncated to 8 chars (which used to render as the
    text "/api/ava" everywhere).
    """
    t = (s or "").strip() if isinstance(s, str) else ""
    if not t:
        return "♟"
    if t.startswith("/api/avatars/"):
        return t[:256]
    if t.startswith("/api/"):
        # Looks like a URL prefix that got truncated by an older client
        # — drop it rather than show garbled text.
        return "♟"
    return t[:8]


def _sanitize_hex_color(s: Any) -> str:
    """Returns ``s`` lowercased iff it's a syntactically valid hex
    colour (#rgb or #rrggbb), otherwise the empty string. Used to
    clamp client-supplied colour values before storing them on a
    member — we never trust the client to send well-formed CSS."""
    if not isinstance(s, str):
        return ""
    s = s.strip()
    if _HEX_COLOR_RE.match(s):
        return s.lower()
    return ""


def _sanitize_square(s: Any) -> str | None:
    if not isinstance(s, str):
        return None
    s = s.strip().lower()
    return s if _SQUARE_RE.match(s) else None


def _sanitize_squares(seq: Any) -> list[str]:
    if not isinstance(seq, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in seq[:32]:  # cap to reasonable upper bound (max ~28 from a queen)
        sq = _sanitize_square(item)
        if sq and sq not in seen:
            seen.add(sq)
            out.append(sq)
    return out


def _sanitize_piece_id(s: Any) -> str | None:
    """Accepts the client's piece tag (e.g. "wQ", "bP") used purely
    for the spectator overlay icon — never for game logic."""
    if not isinstance(s, str):
        return None
    s = s.strip()
    return s if _PIECE_RE.match(s) else None


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
    # Per-player UI prefs. Spectators render each player's mini-board
    # in *that* player's chosen board theme + piece set, so e.g. a
    # player who picked the green board with merida pieces is shown
    # exactly like that on every watcher's screen, regardless of what
    # the watcher picked locally.
    theme: str = ""
    pieces: str = ""
    # Live "current consecutive solves" counter shown to spectators as
    # the player's "Серия" badge. Resets on a fail or skip.
    streak: int = 0
    best_streak: int = 0
    # Index into the party's shared puzzle queue. Each player advances
    # their own pointer when they finish a puzzle (solve / fail / skip),
    # so members work through the *same* shuffled list — whoever is
    # faster lands more attempts.
    puzzle_index: int = 0
    current_puzzle: dict[str, Any] | None = None
    current_started_at: float = 0.0
    # Latest FEN we've seen the player at — pushed to spectators every
    # PLAYER_STATE_THROTTLE_SEC so they can render the live board.
    current_fen: str = ""
    # Whether the player's local board is currently flipped
    # (black-on-bottom). Spectators mirror this so their mini-board has
    # the same orientation — otherwise the player solving for black
    # sees the board one way and watchers see the inverse.
    flipped: bool = False
    # "e2e4"-style coords of the player's last applied move so the
    # spectator can paint a yellow last-move highlight that matches the
    # main board.
    last_move: str = ""
    # Hex (#rrggbb) colour the player picked for "legal move" hints.
    # Spectators paint their own hint dots in this same colour so the
    # watching experience matches what the player sees.
    legal_color: str = "#28c85a"
    # Player's current selection (square they clicked or are dragging).
    # Spectators get a copy of this so they can render the same dots /
    # rings on candidate squares the player sees mid-think.
    # Shape: {"from": "e2", "piece": "wP",
    #         "legal_moves": ["e3","e4"], "legal_captures": ["d3"]}
    selection: dict[str, Any] | None = None
    last_solve_ms: int = 0
    # Per-puzzle attempts log for the post-match summary. Each entry
    # is `{puzzle_id, rating, outcome, solve_ms, themes}`. Capped at
    # PARTY_MAX_ATTEMPT_LOG so a runaway match can't blow up memory.
    # Replicated into the player's profile by `Party.finish()` so the
    # detailed breakdown survives the room shutdown.
    attempts_log: list[dict[str, Any]] = field(default_factory=list)
    # Lives remaining (chess.com Battle style — first to drain all of
    # them ends the match for everyone). Reset to ``PARTY_LIVES_PER_PLAYER``
    # on `Party.start()`.
    lives: int = PARTY_LIVES_PER_PLAYER
    # Per-attempt outcome row used to draw the vertical streak grid in
    # the scoreboard. ``True`` for solved, ``False`` for failed. Skipped
    # puzzles do NOT appear here so a "пропустить" doesn't paint a red
    # cell. Capped at PARTY_MAX_ATTEMPT_LOG just like ``attempts_log``.
    attempts_grid: list[bool] = field(default_factory=list)
    # Wallclock when the player ran out of lives. ``None`` for active
    # players. Used to (a) freeze the player's UI / stop dispatching
    # next_puzzle, (b) order the elimination-order column in the result
    # table — earlier eliminations rank below later ones.
    eliminated_at: float | None = None
    disconnected_at: float | None = None
    is_host: bool = False
    # Wallclock of the last spectator broadcast for this member; used
    # to throttle spammy player_state events.
    last_state_broadcast: float = 0.0


@dataclass
class Spectator:
    client_id: str
    nickname: str
    avatar: str
    ws: WebSocket | None = None
    disconnected_at: float | None = None


@dataclass
class Party:
    party_id: str
    code: str
    host_id: str
    created_at: float
    status: str = "lobby"  # lobby | playing | finished
    started_at: float = 0.0
    ends_at: float = 0.0
    # Match length picked by the host before pressing "Start". Bound
    # to PARTY_ALLOWED_DURATIONS_SEC so a tampered WS payload can't
    # request something absurd. Defaults to 10 min.
    duration_sec: int = PARTY_DURATION_SEC
    members: dict[str, Member] = field(default_factory=dict)
    spectators: dict[str, Spectator] = field(default_factory=dict)
    finish_task: asyncio.Task[None] | None = None
    finished_results: list[dict[str, Any]] = field(default_factory=list)
    # Shared, shuffled puzzle order for the whole match. Built in
    # `start()` from the entire pool, then re-used across every member.
    puzzle_queue: list[dict[str, Any]] = field(default_factory=list)
    # Average rating of all members at the moment of `start()`. We use it
    # to scope the puzzle bank for this match so a 1200-rated lobby
    # doesn't end up grinding 600-rated puzzles. Mirrored back to the
    # client in `public_state()` so the lobby UI can show "средний эло".
    avg_rating: int = 0
    # Puzzle-rating mode — either:
    #   "standard": pick puzzles around the lobby's average ELO (legacy
    #     behaviour). ``rating_min`` / ``rating_max`` are populated by
    #     ``start()`` from the average ± band, but the *source of truth*
    #     for the post-match summary is still the avg ELO.
    #   "custom": host pre-selects an explicit ``[rating_min, rating_max]``
    #     window in the lobby; we sample puzzles strictly from that range
    #     (clipped to ``PARTY_BAND_MIN..PARTY_BAND_MAX``).
    mode: str = "standard"
    rating_min: int = 0
    rating_max: int = 0

    def average_member_rating(self) -> int:
        """Live average of every member's profile rating.

        Falls back to 1200 if no member has a rating set (fresh client_id
        with no puzzle history).
        """
        ratings: list[int] = []
        for m in self.members.values():
            u = users_db.get_user(m.client_id) or {}
            r = int(u.get("rating") or 0)
            if r > 0:
                ratings.append(r)
        if not ratings:
            return 1200
        return int(round(sum(ratings) / len(ratings)))

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
            "streak": m.streak,
            "best_streak": m.best_streak,
            "theme": m.theme,
            "pieces": m.pieces,
            "online": m.ws is not None,
            "lives": int(m.lives),
            "lives_max": PARTY_LIVES_PER_PLAYER,
            # Solved/failed sequence (chess.com vertical streak grid).
            # Booleans (true=solved, false=failed); the frontend wraps
            # at PARTY_GRID_COL_HEIGHT into multiple columns.
            "attempts_grid": list(m.attempts_grid),
            "eliminated": m.eliminated_at is not None,
            "eliminated_at": int(m.eliminated_at) if m.eliminated_at else 0,
        }

    def public_state(self) -> dict[str, Any]:
        return {
            "party_id": self.party_id,
            "code": self.code,
            "host_id": self.host_id,
            "status": self.status,
            "started_at": int(self.started_at),
            "ends_at": int(self.ends_at),
            "duration_sec": int(self.duration_sec),
            "allowed_durations_sec": list(PARTY_ALLOWED_DURATIONS_SEC),
            "members": [self.public_member(m) for m in self.members.values()],
            "spectator_count": sum(1 for s in self.spectators.values() if s.ws is not None),
            "avg_rating": int(self.avg_rating or self.average_member_rating()),
            "lives_per_player": PARTY_LIVES_PER_PLAYER,
            "grid_col_height": PARTY_GRID_COL_HEIGHT,
            "mode": self.mode,
            "rating_min": int(self.rating_min),
            "rating_max": int(self.rating_max),
            "rating_envelope_min": PARTY_BAND_MIN,
            "rating_envelope_max": PARTY_BAND_MAX,
        }

    def scoreboard(self) -> list[dict[str, Any]]:
        rows = [self.public_member(m) for m in self.members.values()]
        rows.sort(key=lambda r: (-r["score"], -r["solved"], r["nickname"] or ""))
        return rows

    async def broadcast(self, payload: dict[str, Any]) -> None:
        """Send to every connected member AND spectator."""
        dead_members: list[str] = []
        for cid, m in self.members.items():
            if m.ws is None:
                continue
            try:
                await m.ws.send_json(payload)
            except Exception:
                dead_members.append(cid)
        for cid in dead_members:
            await self._mark_disconnect(cid)
        await self.broadcast_spectators(payload)

    async def broadcast_spectators(self, payload: dict[str, Any]) -> None:
        dead_specs: list[str] = []
        for cid, s in self.spectators.items():
            if s.ws is None:
                continue
            try:
                await s.ws.send_json(payload)
            except Exception:
                dead_specs.append(cid)
        for cid in dead_specs:
            sp = self.spectators.get(cid)
            if sp:
                sp.ws = None
                sp.disconnected_at = time.time()

    async def _send(self, cid: str, payload: dict[str, Any]) -> None:
        m = self.members.get(cid)
        if not m or m.ws is None:
            return
        try:
            await m.ws.send_json(payload)
        except Exception:
            await self._mark_disconnect(cid)

    async def _send_spectator(self, cid: str, payload: dict[str, Any]) -> None:
        s = self.spectators.get(cid)
        if not s or s.ws is None:
            return
        try:
            await s.ws.send_json(payload)
        except Exception:
            s.ws = None
            s.disconnected_at = time.time()

    def _player_state_payload(self, m: Member) -> dict[str, Any]:
        cur = m.current_puzzle or {}
        return {
            "type": "player_state",
            "client_id": m.client_id,
            "flipped": bool(m.flipped),
            "last_move": m.last_move or "",
            "nickname": m.nickname,
            "avatar": m.avatar,
            "score": m.score,
            "solved": m.solved,
            "failed": m.failed,
            "skipped": m.skipped,
            "streak": m.streak,
            "best_streak": m.best_streak,
            "theme": m.theme,
            "pieces": m.pieces,
            "legal_color": m.legal_color or "#28c85a",
            "selection": m.selection,
            "puzzle_id": cur.get("id"),
            "fen": m.current_fen or str(cur.get("fen") or ""),
            "puzzle_rating": int(cur.get("rating") or 0),
            "side_to_solve": _puzzle_payload(cur).get("side_to_solve") if cur else None,
        }

    async def broadcast_player_state(self, m: Member, *, force: bool = False) -> None:
        """Push a player's current board to spectators.

        Throttled at PLAYER_STATE_THROTTLE_SEC unless ``force`` is set
        (e.g. a fresh puzzle starts) so a flurry of moves doesn't blast
        the spectator stream.
        """
        if not self.spectators:
            return
        now = time.time()
        if not force and now - m.last_state_broadcast < PLAYER_STATE_THROTTLE_SEC:
            return
        m.last_state_broadcast = now
        await self.broadcast_spectators(self._player_state_payload(m))

    async def _mark_disconnect(self, cid: str) -> None:
        m = self.members.get(cid)
        if not m:
            return
        m.ws = None
        m.disconnected_at = time.time()

    def _next_puzzle_for(self, m: Member) -> dict[str, Any] | None:
        # Don't dispatch any further puzzles to a player who has been
        # eliminated (out of lives) — they can flip to spectator mode
        # but the match keeps running for everyone else.
        if m.eliminated_at is not None or m.lives <= 0:
            m.current_puzzle = None
            return None
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
        m.current_fen = str(p.get("fen") or "")
        # Drop the previous puzzle's last-move highlight so spectators
        # don't keep painting an arrow from the puzzle that just ended.
        m.last_move = ""
        # And clear any in-progress selection — the new puzzle has its
        # own legal moves and the old hint dots would be misleading.
        m.selection = None
        return p

    async def attach(
        self,
        client_id: str,
        nickname: str,
        avatar: str,
        ws: WebSocket,
        *,
        theme: str = "",
        pieces: str = "",
        legal_color: str = "",
    ) -> Member:
        existing = self.members.get(client_id)
        sanitized_color = _sanitize_hex_color(legal_color) if legal_color else ""
        if existing is None:
            if len([m for m in self.members.values() if m.ws is not None]) >= MAX_MEMBERS:
                raise PartyError("party_full", "Party is full")
            if self.status != "lobby":
                raise PartyError("in_progress", "Party already started")
            existing = Member(
                client_id=client_id,
                nickname=nickname[:32] or "Гость",
                avatar=_norm_avatar(avatar),
                ws=ws,
                is_host=(client_id == self.host_id),
                theme=(theme or "")[:32],
                pieces=(pieces or "")[:32],
                legal_color=sanitized_color or "#28c85a",
            )
            self.members[client_id] = existing
        else:
            existing.ws = ws
            existing.disconnected_at = None
            if nickname:
                existing.nickname = nickname[:32]
            if avatar:
                existing.avatar = _norm_avatar(avatar)
            if theme:
                existing.theme = theme[:32]
            if pieces:
                existing.pieces = pieces[:32]
            if sanitized_color:
                existing.legal_color = sanitized_color
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
        # Lobby parties are fluid — if a member's WS dies before the
        # match starts, drop them entirely so the lobby count and the
        # "Открытые пати" listing reflect reality. During a live match
        # we keep their slot so a brief reconnect doesn't lose their
        # score.
        if self.status == "lobby":
            await self.leave(client_id)
            return
        await self._mark_disconnect(client_id)
        await self.broadcast({"type": "lobby", **self.public_state()})

    async def leave(self, client_id: str) -> None:
        """Hard-remove a member (lobby exit / explicit leave).

        For lobby status this drops the slot entirely so other clients
        see the count go down; if the host leaves we transfer host to
        the next live member or close the party. During a live match
        we keep the slot — leaving mid-match should still preserve the
        score for the final scoreboard, just like a network drop.
        """
        m = self.members.pop(client_id, None) if self.status == "lobby" else None
        if m is None:
            await self._mark_disconnect(client_id)
            await self.broadcast({"type": "lobby", **self.public_state()})
            return
        if m.ws is not None:
            try:
                await m.ws.close()
            except Exception:
                pass
        # Host transfer / party close.
        if client_id == self.host_id:
            new_host = next(
                (cid for cid, x in self.members.items() if x.ws is not None),
                None,
            )
            if new_host is None:
                _PARTIES.pop(self.code, None)
                return
            self.host_id = new_host
            self.members[new_host].is_host = True
        await self.broadcast({"type": "lobby", **self.public_state()})

    async def attach_spectator(
        self,
        client_id: str,
        nickname: str,
        avatar: str,
        ws: WebSocket,
    ) -> Spectator:
        existing = self.spectators.get(client_id)
        if existing is None:
            existing = Spectator(
                client_id=client_id,
                nickname=nickname[:32] or "Гость",
                avatar=_norm_avatar(avatar),
                ws=ws,
            )
            self.spectators[client_id] = existing
        else:
            existing.ws = ws
            existing.disconnected_at = None
            if nickname:
                existing.nickname = nickname[:32]
            if avatar:
                existing.avatar = _norm_avatar(avatar)

        # Snapshot the room for the new spectator.
        await self._send_spectator(
            client_id,
            {
                "type": "spectator_init",
                "state": self.public_state(),
                "scoreboard": self.scoreboard(),
                "ends_at": int(self.ends_at),
                "players": [self._player_state_payload(m) for m in self.members.values()],
                "status": self.status,
                "results": self.finished_results if self.status == "finished" else [],
            },
        )
        # Tell the room that spectator count went up.
        await self.broadcast({"type": "lobby", **self.public_state()})
        return existing

    async def detach_spectator(self, client_id: str) -> None:
        s = self.spectators.get(client_id)
        if s is None:
            return
        s.ws = None
        s.disconnected_at = time.time()
        await self.broadcast({"type": "lobby", **self.public_state()})

    async def update_position(
        self,
        client_id: str,
        fen: str,
        *,
        flipped: bool | None = None,
        last_move: str | None = None,
    ) -> None:
        """Player reports a mid-puzzle FEN (after a move attempt).

        Lets spectators watch the move-by-move solve. Throttled.
        ``flipped`` and ``last_move`` are passed through so spectators
        can mirror the player's board orientation and paint the same
        last-move highlight.
        """
        if self.status != "playing":
            return
        m = self.members.get(client_id)
        if m is None or m.current_puzzle is None:
            return
        m.current_fen = str(fen or "")
        if flipped is not None:
            m.flipped = bool(flipped)
        if last_move is not None:
            m.last_move = str(last_move or "")
        await self.broadcast_player_state(m)

    async def update_selection(
        self,
        client_id: str,
        *,
        from_sq: Any,
        piece: Any,
        legal_moves: Any,
        legal_captures: Any,
        legal_color: Any,
    ) -> None:
        """Player tells us what square they're selecting / dragging,
        which squares it can legally move to, and the colour to paint
        the hint dots in. Stored on the member and replicated to
        spectators in the next ``player_state`` broadcast so they see
        the same hint overlay the player sees."""
        m = self.members.get(client_id)
        if m is None:
            return
        sq = _sanitize_square(from_sq)
        if sq is None:
            # Treat as "selection cleared" — spectator wipes the hints.
            if m.selection is None:
                return
            m.selection = None
        else:
            piece_id = _sanitize_piece_id(piece)
            moves = _sanitize_squares(legal_moves)
            captures = _sanitize_squares(legal_captures)
            m.selection = {
                "from": sq,
                "piece": piece_id,
                "legal_moves": moves,
                "legal_captures": captures,
            }
        col = _sanitize_hex_color(legal_color)
        if col:
            m.legal_color = col
        await self.broadcast_player_state(m, force=True)

    async def relay_cursor(
        self,
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
        """Pure relay of a player's pointer position to spectators.

        Coords are normalized to the player's board (``0..1`` from
        top-left of the *rendered* board, so a flipped board is in
        screen-space already). ``selected`` is an algebraic square
        ("e4") if the player has a square highlighted, ``dragging``
        marks an active drag — both let spectators show "thinking"
        state on top of the live FEN.
        """
        if not self.spectators:
            return
        m = self.members.get(client_id)
        if m is None:
            return
        # Stay safe on garbage input; the JS layer normalizes but the
        # server is the trust boundary.
        try:
            xv = max(-0.05, min(1.05, float(x)))
            yv = max(-0.05, min(1.05, float(y)))
        except (TypeError, ValueError):
            return
        sel = _sanitize_square(selected) or ""
        dp = _sanitize_piece_id(drag_piece) or ""
        df = _sanitize_square(drag_from) or ""
        await self.broadcast_spectators(
            {
                "type": "player_cursor",
                "client_id": m.client_id,
                "x": xv,
                "y": yv,
                "flipped": bool(flipped),
                "selected": sel,
                "dragging": bool(dragging),
                "drag_piece": dp,
                "drag_from": df,
            }
        )

    async def start(
        self,
        by_client_id: str,
        duration_sec: int | None = None,
        *,
        mode: str | None = None,
        rating_min: int | None = None,
        rating_max: int | None = None,
    ) -> None:
        if by_client_id != self.host_id:
            raise PartyError("not_host", "Only the host can start")
        # Idempotent: if the host clicks the start button several times
        # in a row (or the WS reconnects and replays the message), the
        # follow-up calls are ignored silently rather than raising — so
        # we never re-roll the puzzle queue mid-match (which used to
        # leave players on different puzzles than the one already
        # dispatched on the first click).
        if self.status != "lobby":
            return
        if not self.members:
            raise PartyError("empty", "No members")
        # Host can switch mode / rating range right at start time
        # without recreating the lobby — useful when they realize
        # right before the match begins they want a different bracket.
        if mode is not None:
            mode_norm = str(mode).strip().lower()
            if mode_norm in ("standard", "custom"):
                self.mode = mode_norm
        if self.mode == "custom":
            if rating_min is not None:
                try:
                    self.rating_min = max(0, min(4000, int(rating_min)))
                except (TypeError, ValueError):
                    pass
            if rating_max is not None:
                try:
                    self.rating_max = max(0, min(4000, int(rating_max)))
                except (TypeError, ValueError):
                    pass
        # Match length is hard-coded to 3 min (chess.com Battle style).
        # `duration_sec` is still accepted on the wire so older clients
        # don't error out, but anything other than the canonical value
        # is silently clamped.
        self.duration_sec = PARTY_DURATION_SEC
        now = time.time()
        self.status = "playing"
        self.started_at = now
        self.ends_at = now + self.duration_sec
        # Reset per-player game-state on every start so a re-used room
        # (host left → re-created) begins with a clean slate of lives
        # and an empty streak grid for everyone.
        for m in self.members.values():
            m.lives = PARTY_LIVES_PER_PLAYER
            m.attempts_grid = []
            m.score = 0
            m.solved = 0
            m.failed = 0
            m.skipped = 0
            m.streak = 0
            m.best_streak = 0
            m.attempts_log = []
            m.eliminated_at = None
        # Sample a fresh queue from the puzzle bank for each match. Every
        # member walks through that same ordered list, so the comparison
        # is fair (same puzzles, same order); a different sample per match
        # keeps players from seeing identical openings.
        avg_rating = self.average_member_rating()
        self.avg_rating = avg_rating
        if self.mode == "custom" and self.rating_min and self.rating_max and self.rating_min < self.rating_max:
            lo = max(PARTY_BAND_MIN, int(self.rating_min))
            hi = min(PARTY_BAND_MAX, int(self.rating_max))
            self.rating_min = lo
            self.rating_max = hi
            self.puzzle_queue = _sample_custom_range_queue(lo, hi, PARTY_QUEUE_SIZE)
        else:
            # Standard: scoped to the lobby's *average* rating
            # ±PARTY_BAND_HALF_WIDTH so a 1200-rated lobby drills
            # 850–1550 puzzles instead of the bank's full spread; closes
            # the door on rating farming when a strong player joins a
            # beginner lobby.
            self.mode = "standard"
            self.rating_min = max(PARTY_BAND_MIN, avg_rating - PARTY_BAND_HALF_WIDTH)
            self.rating_max = min(PARTY_BAND_MAX, avg_rating + PARTY_BAND_HALF_WIDTH)
            self.puzzle_queue = _sample_band_queue(avg_rating, PARTY_QUEUE_SIZE)
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
                await self.broadcast_player_state(m, force=True)
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
            await asyncio.sleep(self.duration_sec)
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
        # Snapshot puzzle metadata before we rotate to the next one,
        # otherwise the attempts_log entry would point at whatever
        # came after.
        prev_puzzle = m.current_puzzle
        prev_rating = int(prev_puzzle.get("rating") or 1200)
        prev_themes_raw = prev_puzzle.get("themes") or []
        if isinstance(prev_themes_raw, str):
            prev_themes = [t for t in prev_themes_raw.split() if t][:8]
        else:
            prev_themes = [str(t) for t in prev_themes_raw][:8]
        score_delta = 0
        # Eliminated players (out of lives) shouldn't influence the
        # scoreboard further — their attempts/state are frozen until
        # `finish()`.
        if m.lives <= 0 or m.eliminated_at is not None:
            return
        if outcome == "solved":
            m.solved += 1
            m.last_solve_ms = int(solve_ms)
            score_delta = _score_for(prev_rating, int(solve_ms))
            m.score += score_delta
            m.streak += 1
            if m.streak > m.best_streak:
                m.best_streak = m.streak
            if len(m.attempts_grid) < PARTY_MAX_ATTEMPT_LOG:
                m.attempts_grid.append(True)
        elif outcome == "failed":
            m.failed += 1
            m.streak = 0
            m.lives = max(0, m.lives - 1)
            if len(m.attempts_grid) < PARTY_MAX_ATTEMPT_LOG:
                m.attempts_grid.append(False)
        else:
            m.skipped += 1
            m.streak = 0
        if len(m.attempts_log) < PARTY_MAX_ATTEMPT_LOG:
            m.attempts_log.append(
                {
                    "puzzle_id": str(prev_puzzle.get("id") or ""),
                    "rating": prev_rating,
                    "outcome": outcome if outcome in ("solved", "failed", "skipped") else "skipped",
                    "solve_ms": int(solve_ms) if outcome == "solved" else 0,
                    "score": score_delta,
                    "themes": prev_themes,
                }
            )
        # Player just ran out of lives — they're eliminated. Mark the
        # timestamp (drives placement order in `finish()`), drop them
        # from active dispatch (no next_puzzle), tell the client so it
        # can offer "watch the rest of the match" via the existing
        # spectator flow, and broadcast the new scoreboard so the
        # cards on every screen show their dimmed/red state.
        just_eliminated = False
        if m.lives <= 0 and m.eliminated_at is None:
            m.eliminated_at = time.time()
            m.current_puzzle = None
            just_eliminated = True
            await self._send(
                client_id,
                {
                    "type": "eliminated",
                    "client_id": client_id,
                    "lives": int(m.lives),
                    "lives_max": PARTY_LIVES_PER_PLAYER,
                    "score": int(m.score),
                    "solved": int(m.solved),
                    "failed": int(m.failed),
                    "skipped": int(m.skipped),
                    "eliminated_at": int(m.eliminated_at),
                },
            )
        # Push next puzzle iff the player is still alive — eliminated
        # players keep their stale board for a beat (until they switch
        # to spectator mode) instead of yanking it instantly.
        if not just_eliminated and m.eliminated_at is None:
            nxt = self._next_puzzle_for(m)
            if nxt is not None:
                await self._send(
                    client_id,
                    {"type": "next_puzzle", "puzzle": _puzzle_payload(nxt)},
                )
                await self.broadcast_player_state(m, force=True)
        await self.broadcast(
            {
                "type": "scoreboard",
                "ends_at": int(self.ends_at),
                "scoreboard": self.scoreboard(),
            }
        )
        # Last-man-standing finish: only end the match when at most
        # one player still has lives left. With 1 player solo (no
        # opponents) we don't auto-finish on elimination — the timer
        # still owns that case.
        survivors = sum(1 for mm in self.members.values() if mm.lives > 0 and mm.eliminated_at is None)
        total_started = sum(1 for mm in self.members.values() if mm.score or mm.solved or mm.failed or mm.skipped or mm.eliminated_at is not None or mm.lives > 0)
        if just_eliminated and total_started >= 2 and survivors <= 1:
            if self.finish_task and not self.finish_task.done():
                self.finish_task.cancel()
            await self.finish()

    async def finish(self) -> None:
        if self.status == "finished":
            return
        self.status = "finished"
        rows = self.scoreboard()
        # First pass: build the per-row entry that goes into the
        # broadcast & profile history. The frontend renders this dict
        # verbatim, so any new field added here also shows up in the
        # detailed end-of-match table and the clickable battle history
        # in the profile.
        results: list[dict[str, Any]] = []
        for rank, row in enumerate(rows, start=1):
            placement = rank
            participants = len(rows)
            party_elo = _party_elo_award(placement, participants, row["solved"], row["score"])
            cid = row["client_id"]
            m = self.members.get(cid)
            attempts_total = row["solved"] + row["failed"] + row["skipped"]
            winrate = (row["solved"] / attempts_total * 100.0) if attempts_total else 0.0
            solve_ms_list = [int(a.get("solve_ms") or 0) for a in (m.attempts_log if m else []) if a.get("outcome") == "solved" and int(a.get("solve_ms") or 0) > 0]
            avg_solve_ms = int(sum(solve_ms_list) / len(solve_ms_list)) if solve_ms_list else 0
            best_solve_ms = min(solve_ms_list) if solve_ms_list else 0
            entry = {
                "rank": rank,
                "client_id": cid,
                "nickname": row["nickname"],
                "avatar": row["avatar"],
                "score": row["score"],
                "solved": row["solved"],
                "failed": row["failed"],
                "skipped": row["skipped"],
                "attempts": attempts_total,
                "winrate": round(winrate, 1),
                "best_streak": row.get("best_streak", 0) if isinstance(row, dict) else (m.best_streak if m else 0),
                "avg_solve_ms": avg_solve_ms,
                "best_solve_ms": best_solve_ms,
                "party_elo": party_elo,
                "lives_left": int(m.lives) if m else 0,
                "eliminated_at": int(m.eliminated_at) if (m and m.eliminated_at) else 0,
                "attempts_grid": list(m.attempts_grid) if m else [],
            }
            results.append(entry)
        # Second pass: write per-player profile history. We pass the
        # *full* scoreboard alongside each player's own attempts log so
        # opening a single battle from the profile re-renders the same
        # detailed stats table everyone sees right after finish.
        finished_at = int(time.time())
        for entry in results:
            cid = entry["client_id"]
            m = self.members.get(cid)
            attempts_log = list(m.attempts_log) if m else []
            try:
                users_db.record_party_result(
                    cid,
                    {
                        "party_id": self.party_id,
                        "placement": entry["rank"],
                        "participants": len(results),
                        "solved": entry["solved"],
                        "failed": entry["failed"],
                        "skipped": entry["skipped"],
                        "score": entry["score"],
                        "winrate": entry["winrate"],
                        "best_streak": entry["best_streak"],
                        "avg_solve_ms": entry["avg_solve_ms"],
                        "best_solve_ms": entry["best_solve_ms"],
                        "elo_gained": entry["party_elo"],
                        "duration_sec": int(self.duration_sec),
                        "started_at": int(self.started_at),
                        "ended_at": finished_at,
                        # Mode the host picked + the rating window
                        # actually used. For "standard" the window is
                        # avg±band so the profile-history modal can
                        # show "ср. ELO 1320 (1170–1470)"; for "custom"
                        # it's the explicit ``[min, max]`` the host
                        # typed.
                        "mode": self.mode,
                        "rating_min": int(self.rating_min),
                        "rating_max": int(self.rating_max),
                        "avg_rating": int(self.avg_rating),
                        # Last-man-standing flag — false if the match
                        # ended on the timer, true if the result
                        # broadcast was triggered by the elimination
                        # branch in attempt(). The frontend uses it to
                        # paint a "Победа нокаутом" badge.
                        "lives_per_player": PARTY_LIVES_PER_PLAYER,
                        # Full scoreboard so the profile detail modal
                        # can show every opponent's row, not just the
                        # owner's stats.
                        "results": results,
                        # The owner's own per-puzzle log. Capped server-
                        # side (see PARTY_MAX_ATTEMPT_LOG) so we never
                        # bloat users.json.
                        "attempts": attempts_log,
                    },
                )
            except Exception:
                # Profile write failures shouldn't take the room down.
                pass
        self.finished_results = results
        await self.broadcast(
            {
                "type": "finish",
                "results": results,
                "duration_sec": int(self.duration_sec),
                "party_id": self.party_id,
                "started_at": int(self.started_at),
                "ended_at": finished_at,
                "mode": self.mode,
                "rating_min": int(self.rating_min),
                "rating_max": int(self.rating_max),
                "avg_rating": int(self.avg_rating),
                "lives_per_player": PARTY_LIVES_PER_PLAYER,
            }
        )


def _sample_custom_range_queue(lo: int, hi: int, n: int) -> list[dict[str, Any]]:
    """Sample ``n`` puzzles strictly from ``[lo, hi]`` (custom mode).

    Falls back to ``_sample_band_queue`` around the midpoint if the
    explicit window is too narrow to fill the queue, so a host who
    types a tiny range (e.g. 1500..1505) doesn't end up with an empty
    match.
    """
    if n <= 0:
        return []
    lo = max(PARTY_BAND_MIN, int(lo))
    hi = min(PARTY_BAND_MAX, int(hi))
    if hi <= lo:
        hi = min(PARTY_BAND_MAX, lo + 50)
    pool = puzzle_pack.filter_puzzles(min_rating=lo, max_rating=hi)
    if len(pool) >= n:
        random.shuffle(pool)
        return pool[:n]
    if pool:
        random.shuffle(pool)
        # Top up with the standard band fallback so the queue never
        # comes out short — the host's window stays the *primary*
        # source, the rest are sampled around the midpoint.
        midpoint = (lo + hi) // 2
        backfill = _sample_band_queue(midpoint, n - len(pool))
        return pool + backfill
    return _sample_band_queue((lo + hi) // 2, n)


def _sample_band_queue(avg_rating: int, n: int) -> list[dict[str, Any]]:
    """Sample ``n`` puzzles centred on ``avg_rating``.

    Two-pass strategy:

    1. Try the strict band ``[avg-HALF_WIDTH, avg+HALF_WIDTH]``.
    2. If that comes up short (small bank, edge of the rating spectrum),
       widen one band's worth at a time until we either fill the queue
       or hit the global ``[PARTY_BAND_MIN, PARTY_BAND_MAX]`` envelope.

    Falls back to ``puzzle_pack.sample_puzzles`` only if the bank can't
    even produce one match, so we never break a lobby.
    """
    if n <= 0:
        return []
    width = PARTY_BAND_HALF_WIDTH
    while True:
        lo = max(PARTY_BAND_MIN, avg_rating - width)
        hi = min(PARTY_BAND_MAX, avg_rating + width)
        pool = puzzle_pack.filter_puzzles(min_rating=lo, max_rating=hi)
        if len(pool) >= n:
            random.shuffle(pool)
            return pool[:n]
        if width >= (PARTY_BAND_MAX - PARTY_BAND_MIN):
            # Even the maximum envelope can't fill the queue: top up
            # with whatever the bank does have.
            if pool:
                random.shuffle(pool)
                return pool
            return list(puzzle_pack.sample_puzzles(n))
        width += PARTY_BAND_HALF_WIDTH


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
            avatar=_norm_avatar(host_avatar),
            ws=None,
            is_host=True,
        )
        _PARTIES[code] = party
        return party


def get_party(code: str) -> Party | None:
    return _PARTIES.get(code.upper())


def list_open() -> list[dict[str, Any]]:
    """Public list of joinable parties (lobby-status or in-flight matches).

    Used by the frontend "backup-join" path: if a friend dismissed the
    invitation toast they can still find the party here and click join.
    Parties with no live (connected) members are filtered out — without
    that we'd show ghost rooms forever after everyone left, and the
    member counter would stay at the peak headcount even after the
    last person ливнул.
    """
    # Self-cleaning: drop stale rooms before computing the listing so
    # callers can't see a finished/empty party.
    _drop_stale()
    rows: list[dict[str, Any]] = []
    for p in _PARTIES.values():
        if p.status == "finished":
            continue
        live = [m for m in p.members.values() if m.ws is not None]
        if not live:
            continue
        host = p.members.get(p.host_id)
        rows.append(
            {
                "code": p.code,
                "party_id": p.party_id,
                "status": p.status,
                "host_id": p.host_id,
                "host_nickname": host.nickname if host else "Гость",
                "host_avatar": host.avatar if host else "♟",
                "members": len(live),
                "spectator_count": sum(1 for s in p.spectators.values() if s.ws is not None),
                "ends_at": int(p.ends_at) if p.status == "playing" else 0,
                "created_at": int(p.created_at),
            }
        )
    rows.sort(key=lambda r: -r["created_at"])
    return rows


def _drop_stale() -> None:
    """Remove parties no one is in (lobby) or that have been finished long ago.

    Conservative on ``status == "playing"`` so a brief network blip
    doesn't kill an active match — we only drop those if they've also
    timed out (``ends_at`` in the past) AND have no live members.
    """
    now = time.time()
    drop: list[str] = []
    for code, p in _PARTIES.items():
        if p.status == "finished" and now - p.ends_at > 1800:
            drop.append(code)
            continue
        if any(m.ws is not None for m in p.members.values()):
            continue
        # No live members.
        if p.status == "lobby":
            if now - p.created_at >= LOBBY_GRACE_SEC:
                drop.append(code)
        elif p.status == "playing":
            # Match clock expired and the room is empty — safe to drop.
            if p.ends_at and now > p.ends_at:
                drop.append(code)
    for code in drop:
        _PARTIES.pop(code, None)


def reap_idle() -> None:
    """Drop parties that have been finished or empty for too long.

    Thin wrapper around :func:`_drop_stale` kept for backwards
    compatibility with the HTTP endpoints that still call it.
    """
    _drop_stale()


def reset_for_tests() -> None:
    """Test-only helper: drop the in-memory party registry."""
    _PARTIES.clear()
