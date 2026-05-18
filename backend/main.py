"""FastAPI application exposing the sandbox UI and the engine/recognition APIs."""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import time
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path
from typing import Annotated, Any

import chess
from fastapi import (
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

from . import daily_puzzle as daily_puzzle_pack
from . import notifications as notifications_db
from . import onevsone as onevsone_room
from . import opening_trainer as opening_trainer_pack
from . import party as party_room
from . import presence as presence_room
from . import puzzle_rush as puzzle_rush_room
from . import puzzles as puzzles_db
from . import users as users_db
from .analysis import analyse_game, import_game_async
from .recognize import diagnostics as recognize_diagnostics
from .recognize import recognize as recognize_position
from .settings import settings
from .stockfish_engine import EngineOptions, engine

logger = logging.getLogger(__name__)


class EngineConfigRequest(BaseModel):
    path: str | None = Field(
        default=None,
        description="Absolute path to the Stockfish binary. If omitted, the server-side default is used.",
    )
    threads: int = Field(default=2, ge=1, le=64)
    hash_mb: int = Field(default=256, ge=16, le=8192)
    skill_level: int = Field(default=20, ge=0, le=20)
    multi_pv: int = Field(default=1, ge=1, le=8)


class BestMoveRequest(BaseModel):
    fen: str
    movetime_ms: int | None = Field(default=None, ge=10, le=120_000)
    depth: int | None = Field(default=None, ge=1, le=60)


class AnalyseRequest(BestMoveRequest):
    multipv: int = Field(default=1, ge=1, le=8)


class ApplyMoveRequest(BaseModel):
    fen: str
    move_uci: str


class GameImportRequest(BaseModel):
    source: str = Field(
        ...,
        description="A chess.com / lichess.org game URL, or a raw PGN.",
    )


class GameAnalyseRequest(BaseModel):
    moves_uci: list[str] = Field(..., min_length=1)
    starting_fen: str = Field(default=chess.STARTING_FEN)
    movetime_ms: int | None = Field(default=None, ge=50, le=60_000)
    depth: int | None = Field(default=22, ge=1, le=40)
    multipv: int = Field(default=2, ge=1, le=4)


class UserUpsertRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)
    nickname: str = Field(default="Гость", max_length=32)
    # 256 chars covers both single-glyph emoji avatars and the longer
    # ``/api/avatars/<cid>.png?v=<ts>`` URLs produced by the upload
    # endpoint after a player chooses a custom photo.
    avatar: str = Field(default="♟", max_length=256)


class HeartbeatRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)


class PuzzleAttemptRequest(BaseModel):
    """Client-submitted puzzle attempt.

    NOTE: rating math (delta / new_rating) is computed server-side from
    the puzzle's *canonical* rating in the SQLite bank, the user's
    current server-side rating, and the outcome. Clients used to send
    these numbers themselves, which let anyone bump their leaderboard
    rating to 3000 with a single curl. Any extra fields in the payload
    are ignored.
    """
    client_id: str = Field(..., min_length=4, max_length=64)
    outcome: str = Field(..., description="solved|solved-hint|failed|skipped")
    puzzle_id: str | None = Field(default=None, max_length=64)
    solve_ms: int | None = Field(default=None, ge=0, le=10_000_000)


class PartyInviteRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)
    target_id: str = Field(..., min_length=4, max_length=64)
    code: str = Field(..., min_length=4, max_length=8)


class InviteActionRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)


class PuzzleRushStartRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)
    mode: str = Field(..., description="3min | 5min | survival")


class PuzzleRushAttemptRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)
    session_id: str = Field(..., min_length=4, max_length=64)
    puzzle_id: str = Field(..., min_length=1, max_length=64)
    outcome: str = Field(..., description="solved | failed | skipped")
    solve_ms: int = Field(default=0, ge=0, le=10_000_000)


class PuzzleRushFinalizeRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)
    session_id: str = Field(..., min_length=4, max_length=64)


class DailyPuzzleAttemptRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)
    date: str = Field(..., min_length=10, max_length=10, description="ISO date YYYY-MM-DD (UTC)")
    puzzle_id: str = Field(..., min_length=1, max_length=64)
    outcome: str = Field(..., description="solved | failed")
    solve_ms: int = Field(default=0, ge=0, le=10_000_000)


class OpeningAttemptRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)
    opening_id: str = Field(..., min_length=1, max_length=64)
    ply: int = Field(..., ge=0, le=64)
    san: str = Field(..., min_length=1, max_length=12)


class OneVsOneChallengeRequest(BaseModel):
    """Body for ``POST /api/onevsone/challenge`` — challenger picks a
    target client + a base time control. Increment is optional and
    defaults to 0 (sudden-death). Validation lives in
    :func:`onevsone.create_challenge`."""
    client_id: str = Field(..., min_length=4, max_length=64)
    target_id: str = Field(..., min_length=4, max_length=64)
    time_seconds: int = Field(..., ge=10, le=60 * 60)
    increment_seconds: int = Field(default=0, ge=0, le=60)
    challenger_color: str = Field(default="random", pattern="^(w|b|random)$")


class OneVsOneActionRequest(BaseModel):
    """Body for accept/decline/cancel/resign endpoints."""
    client_id: str = Field(..., min_length=4, max_length=64)


def _print_puzzle_banner() -> None:
    """Print a one-line summary of the puzzle bank at startup.

    Shows the count and source so the operator can immediately tell
    whether the full Lichess SQLite is loaded or the tiny built-in
    fallback.
    """
    try:
        stats = puzzles_db.stats()
    except Exception as exc:
        print(f"[chess-sandbox] Пазлы: ошибка чтения базы — {exc}")
        return
    count = stats.get("count", 0)
    source = stats.get("source", "unknown")
    if source == "sqlite":
        print(f"[chess-sandbox] Пазлы: {count:,} (источник: sqlite — Lichess база)")
    else:
        print(
            f"[chess-sandbox] Пазлы: {count:,} (источник: {source} — встроенный набор). "
            f"Запусти `python -m backend.import_puzzles --all` для полной базы Lichess."
        )


def _print_bind_banner() -> None:
    """Warn loudly when the server is exposed publicly without an auth token.

    When ``CHESS_HOST`` resolves to a non-loopback IP (e.g. ``0.0.0.0`` for
    ngrok/playit tunnels), every API endpoint that takes a ``client_id``
    from the body — profile upsert, party/1v1 challenge, WS attach — is
    trustingly assigning that id to the caller. Without
    ``CHESS_AUTH_TOKEN`` set, anyone with the tunnel URL can spoof another
    player's id and overwrite their profile / hijack their match. We
    refuse to silently keep going in that mode; the operator must either
    set ``CHESS_AUTH_TOKEN=<some-shared-secret>`` or accept the risk by
    setting ``CHESS_ALLOW_INSECURE_PUBLIC=1``.
    """
    if settings.host_is_loopback():
        if settings.host_token:
            print(
                "[chess-sandbox] CHESS_HOST_TOKEN включён — настройки "
                "Stockfish (Threads / Hash / Skill) доступны только при "
                "открытии URL с ?host_token=<секрет>."
            )
        return
    if settings.auth_token:
        print(
            f"[chess-sandbox] Сервер слушает {settings.host}:{settings.port}. "
            f"CHESS_AUTH_TOKEN включён — клиенты должны открывать URL с "
            f"?token=<секрет>."
        )
        if settings.host_token:
            print(
                "[chess-sandbox] CHESS_HOST_TOKEN включён — параметры "
                "движка может менять только владелец сервера, "
                "открывший URL с ?host_token=<секрет>."
            )
        return
    import os
    if os.environ.get("CHESS_ALLOW_INSECURE_PUBLIC") == "1":
        print(
            f"[chess-sandbox] ВНИМАНИЕ: сервер слушает {settings.host}:{settings.port} "
            f"без CHESS_AUTH_TOKEN. Любой с URL может подменить чужой "
            f"client_id. CHESS_ALLOW_INSECURE_PUBLIC=1 — запускаемся."
        )
        return
    print(
        f"[chess-sandbox] ОШИБКА: CHESS_HOST={settings.host} не loopback, "
        f"но CHESS_AUTH_TOKEN пуст. Любой с URL подменит client_id и "
        f"перепишет чужой профиль. Установи CHESS_AUTH_TOKEN или явно "
        f"CHESS_ALLOW_INSECURE_PUBLIC=1, либо верни CHESS_HOST=127.0.0.1."
    )
    raise SystemExit(2)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _print_puzzle_banner()
    _print_bind_banner()
    # Try to auto-start the engine if a binary is configured / discoverable.
    path = settings.resolve_stockfish_path()
    if path:
        try:
            await engine.configure(
                path,
                EngineOptions(
                    threads=settings.stockfish_threads,
                    hash_mb=settings.stockfish_hash_mb,
                    skill_level=settings.stockfish_default_skill_level,
                ),
            )
            logger.info("Stockfish auto-started: %s", path)
        except Exception as exc:
            logger.warning("Failed to auto-start Stockfish at %s: %s", path, exc)
    else:
        logger.info("No Stockfish binary configured; configure via /api/engine/configure.")
    # Rehydrate persisted 1v1 matches so a backend restart doesn't lose
    # in-flight games. Players still need to refresh + reattach the WS,
    # which the SSE re-emit on `onevsone.persist_load` handles.
    try:
        await onevsone_room.load_persisted()
    except Exception as exc:
        logger.warning("onevsone.load_persisted failed: %s", exc)
    try:
        yield
    finally:
        await engine.stop()


app = FastAPI(
    title="Chess Sandbox",
    description="Local chess sandbox: free-form position editor, play vs Stockfish, recognize from screenshot.",
    version="0.1.0",
    lifespan=lifespan,
)


# ---- Auth gate (optional shared token for non-loopback deployments) ----
#
# When ``CHESS_AUTH_TOKEN`` is set, every HTTP request and WebSocket
# handshake must include it. The token can travel three ways:
#
#   1. ``?token=<secret>`` query parameter — used for the first hit so
#      the operator only has to share a single URL with friends.
#   2. ``X-Chess-Token`` header — used by AJAX after the cookie is set.
#   3. ``chess_auth`` cookie — auto-issued the moment a request with a
#      valid query token (or header) arrives, so subsequent navigations
#      / WS opens work without the URL parameter.
#
# Endpoints that must run anonymously (so the entry page itself can
# load before the cookie is set) are listed in ``_AUTH_EXEMPT_PATHS``.

# Public paths that bypass the token check. Everything else (including
# ``/`` and WS) demands a valid token when one is configured.
_AUTH_EXEMPT_PATHS: frozenset[str] = frozenset({
    "/api/health",
    "/api/auth/check",
})

_AUTH_COOKIE_NAME = "chess_auth"
_HOST_COOKIE_NAME = "chess_host"


def _auth_token_from_request(request: Request) -> str | None:
    """Pull the bearer token from header / query / cookie, in priority order."""
    header = request.headers.get("x-chess-token")
    if header:
        return header
    qs = request.query_params.get("token")
    if qs:
        return qs
    cookie = request.cookies.get(_AUTH_COOKIE_NAME)
    if cookie:
        return cookie
    return None


def _host_token_from_request(request: Request) -> str | None:
    """Pull the host bearer token from header / query / cookie."""
    header = request.headers.get("x-chess-host-token")
    if header:
        return header
    qs = request.query_params.get("host_token")
    if qs:
        return qs
    cookie = request.cookies.get(_HOST_COOKIE_NAME)
    if cookie:
        return cookie
    return None


def _is_host_request(request: Request) -> bool:
    """Decide whether the caller is the operator who launched the server.

    Two paths grant host privileges:

    1. ``settings.host_token`` is set and the request presents that
       same value via header / query / cookie. This is the canonical
       mechanism used by the public-tunnel launcher scripts, which
       auto-generate a fresh token and bake it into the host's URL.
    2. ``settings.host_token`` is empty AND the request comes from a
       loopback peer (``127.0.0.1`` / ``::1`` / the configured loopback
       hostname). When no token is configured we fall back to "anyone
       on localhost owns the box" so a default local install can still
       tune the engine without any extra setup.
    """
    expected = settings.host_token
    if expected:
        token = _host_token_from_request(request)
        return token is not None and hmac.compare_digest(token, expected)
    client = request.client
    if client is None or not client.host:
        return False
    try:
        return ipaddress_is_loopback(client.host)
    except Exception:
        return False


def ipaddress_is_loopback(host: str) -> bool:
    import ipaddress
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.strip().lower() in {"localhost", "ip6-localhost"}


def _is_static_asset_path(path: str) -> bool:
    """The SPA shell + static files must load anonymously so that the
    auth-required HTML page can render and POST to ``/api/auth/check``."""
    if path == "/" or path == "":
        return True
    if path.startswith("/static/"):
        return True
    if path.startswith("/api/avatars/"):
        return False  # protected — avatars expose client_ids
    if path in ("/favicon.ico", "/robots.txt"):
        return True
    return False


class AuthTokenMiddleware(BaseHTTPMiddleware):
    """Reject requests that don't carry a valid ``CHESS_AUTH_TOKEN``.

    The check is a constant-time string compare to dodge timing-based
    leaks of the configured token. A successful query/header token also
    sets an HttpOnly ``chess_auth`` cookie so the browser remembers it
    without ever exposing the value to JS (and ``location.href`` doesn't
    keep the secret in URL bar history).
    """

    async def dispatch(self, request: Request, call_next):  # type: ignore[override]
        # Host-token cookie pinning runs regardless of whether the
        # auth-token gate is active: a tunnel launcher can bake a
        # ``?host_token=...`` into its own copy of the URL while still
        # leaving CHESS_AUTH_TOKEN empty (or set to a separate value
        # shared with friends). Picking the cookie up here means the
        # host's first visit upgrades them in one round-trip and every
        # subsequent request, including WebSocket handshakes, carries
        # the cookie without keeping the secret in the URL bar.
        host_expected = settings.host_token
        host_token = _host_token_from_request(request) if host_expected else None
        host_token_valid = (
            host_token is not None
            and host_expected != ""
            and hmac.compare_digest(host_token, host_expected)
        )

        def _stamp_host_cookie(resp):
            if host_token_valid and request.cookies.get(_HOST_COOKIE_NAME) != host_expected:
                resp.set_cookie(
                    _HOST_COOKIE_NAME,
                    host_expected,
                    max_age=60 * 60 * 24 * 30,  # 30 days — host rarely rotates
                    httponly=True,
                    samesite="lax",
                )
            return resp

        expected = settings.auth_token
        if not expected:
            return _stamp_host_cookie(await call_next(request))
        path = request.url.path
        is_exempt = path in _AUTH_EXEMPT_PATHS or _is_static_asset_path(path)
        token = _auth_token_from_request(request)
        token_valid = (
            token is not None and hmac.compare_digest(token, expected)
        )
        if is_exempt:
            # Static-asset & SPA-shell paths bypass the gate so the
            # auth-required HTML can render. We still want to harvest a
            # valid ``?token=`` from the *first* hit on ``/`` (or any
            # exempt URL) and bake it into the ``chess_auth`` cookie so
            # subsequent same-origin requests (heartbeat, /api/users,
            # /api/notifications/stream, …) are authed automatically.
            # Without this the SPA reloads itself trying to chase an
            # auth cookie that the middleware kept silently dropping
            # whenever the user landed on the SPA shell first.
            response = await call_next(request)
            if token_valid and request.cookies.get(_AUTH_COOKIE_NAME) != expected:
                response.set_cookie(
                    _AUTH_COOKIE_NAME,
                    expected,
                    max_age=60 * 60 * 24,
                    httponly=True,
                    samesite="lax",
                )
            return _stamp_host_cookie(response)
        if not token_valid:
            # The SPA polls /api/auth/check to detect this state and
            # show the "enter token" view, so we return JSON rather than
            # a redirect.
            return JSONResponse(
                {"detail": "auth required", "code": "auth_required"},
                status_code=401,
            )
        response = await call_next(request)
        # Refresh the cookie on every successful authed request — same
        # max-age each time so an idle tab stays authed for the cookie
        # lifetime (24h) rather than the initial-token-issuance window.
        if request.cookies.get(_AUTH_COOKIE_NAME) != expected:
            response.set_cookie(
                _AUTH_COOKIE_NAME,
                expected,
                max_age=60 * 60 * 24,
                httponly=True,
                samesite="lax",
            )
        return _stamp_host_cookie(response)


app.add_middleware(AuthTokenMiddleware)


@app.get("/api/auth/check")
async def auth_check(request: Request) -> dict[str, Any]:
    """Lightweight probe used by the frontend to know whether the
    backend is in token mode and whether the current visitor already
    holds a valid one. Always responds 200 — the body says whether
    the SPA needs to prompt for a token."""
    expected = settings.auth_token
    is_host = _is_host_request(request)
    if not expected:
        return {
            "auth_required": False,
            "authenticated": True,
            "is_host": is_host,
            "host_token_required": bool(settings.host_token),
        }
    token = _auth_token_from_request(request)
    ok = token is not None and hmac.compare_digest(token, expected)
    return {
        "auth_required": True,
        "authenticated": ok,
        "is_host": is_host,
        "host_token_required": bool(settings.host_token),
    }


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "ok": True,
        "engine": {
            "running": engine.is_running,
            "path": engine.path,
            "configured_path": settings.stockfish_path or None,
            "resolved_path": settings.resolve_stockfish_path(),
        },
        "recognize": recognize_diagnostics(),
    }


def _broadcast_engine_state() -> asyncio.Task:
    """Fire-and-forget SSE broadcast of the current engine state.

    Returns the task so callers can await it explicitly when the test
    suite needs determinism; production code drops the reference.
    """
    return asyncio.create_task(
        notifications_db.broadcast(
            {"type": "engine_state", "engine": engine.current_state()}
        )
    )


@app.get("/api/engine/state")
async def engine_state() -> dict[str, Any]:
    """Current engine configuration. Readable by every authed client
    so a non-host's UI can mirror the host's threads/hash/skill."""
    return {"engine": engine.current_state()}


@app.post("/api/engine/configure")
async def engine_configure(req: EngineConfigRequest, request: Request) -> dict[str, Any]:
    if not _is_host_request(request):
        raise HTTPException(
            status_code=403,
            detail=(
                "Only the server host can change Stockfish settings. "
                "The host token is set by start-public.{sh,ps1} and "
                "baked into the host's URL."
            ),
        )
    path = req.path or settings.resolve_stockfish_path()
    if not path:
        raise HTTPException(
            status_code=400,
            detail="No Stockfish path provided and none discoverable on PATH.",
        )
    try:
        info = await engine.configure(
            path,
            EngineOptions(
                threads=req.threads,
                hash_mb=req.hash_mb,
                skill_level=req.skill_level,
                multi_pv=req.multi_pv,
            ),
        )
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=f"Binary not found: {exc}") from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Engine init failed: {exc}") from exc
    _broadcast_engine_state()
    return {"ok": True, "engine": info}


@app.post("/api/engine/best_move")
async def engine_best_move(req: BestMoveRequest) -> dict[str, Any]:
    if not engine.is_running:
        raise HTTPException(status_code=409, detail="Engine not configured.")
    try:
        chess.Board(req.fen)  # validate
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid FEN: {exc}") from exc
    # Only fall back to the default movetime when the caller passed neither
    # a movetime nor a depth — otherwise a depth-only request would be
    # silently capped by the default 1s search limit.
    if req.movetime_ms is not None:
        movetime: int | None = req.movetime_ms
    elif req.depth is not None:
        movetime = None
    else:
        movetime = settings.stockfish_default_movetime_ms
    try:
        result = await engine.best_move(req.fen, movetime_ms=movetime, depth=req.depth)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return _result_to_dict(result)


@app.post("/api/engine/analyse")
async def engine_analyse(req: AnalyseRequest) -> dict[str, Any]:
    if not engine.is_running:
        raise HTTPException(status_code=409, detail="Engine not configured.")
    try:
        chess.Board(req.fen)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid FEN: {exc}") from exc
    if req.movetime_ms is not None:
        movetime: int | None = req.movetime_ms
    elif req.depth is not None:
        movetime = None
    else:
        movetime = settings.stockfish_default_movetime_ms
    try:
        results = await engine.analyse(
            req.fen, movetime_ms=movetime, depth=req.depth, multipv=req.multipv
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"lines": [_result_to_dict(r) for r in results]}


@app.post("/api/engine/stop")
async def engine_stop(request: Request) -> dict[str, Any]:
    if not _is_host_request(request):
        raise HTTPException(
            status_code=403,
            detail="Only the server host can stop the shared Stockfish engine.",
        )
    await engine.stop()
    _broadcast_engine_state()
    return {"ok": True}


@app.post("/api/move/apply")
async def apply_move(req: ApplyMoveRequest) -> dict[str, Any]:
    """Apply a UCI move to a FEN and return the resulting FEN plus game state."""
    try:
        board = chess.Board(req.fen)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid FEN: {exc}") from exc
    try:
        move = chess.Move.from_uci(req.move_uci)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid UCI move: {exc}") from exc
    if move not in board.legal_moves:
        # Allow promotion to queen even if the user passes a 4-char UCI.
        if len(req.move_uci) == 4:
            promo = chess.Move.from_uci(req.move_uci + "q")
            if promo in board.legal_moves:
                move = promo
            else:
                raise HTTPException(status_code=400, detail="Illegal move for this position.")
        else:
            raise HTTPException(status_code=400, detail="Illegal move for this position.")
    san = board.san(move)
    board.push(move)
    return {
        "fen": board.fen(),
        "san": san,
        "is_check": board.is_check(),
        "is_checkmate": board.is_checkmate(),
        "is_stalemate": board.is_stalemate(),
        "is_insufficient_material": board.is_insufficient_material(),
        "is_game_over": board.is_game_over(claim_draw=True),
    }


@app.post("/api/legal_moves")
async def legal_moves(payload: dict[str, str]) -> dict[str, Any]:
    fen = payload.get("fen", "")
    square = payload.get("square", "")
    try:
        board = chess.Board(fen)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid FEN: {exc}") from exc
    if not square:
        return {"moves": [m.uci() for m in board.legal_moves]}
    try:
        sq = chess.parse_square(square)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid square: {exc}") from exc
    moves = [m.uci() for m in board.legal_moves if m.from_square == sq]
    return {"moves": moves}


_DEFAULT_FILE = File(...)


@app.post("/api/recognize")
async def recognize_endpoint(image: UploadFile = _DEFAULT_FILE) -> dict[str, Any]:
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty image upload.")
    try:
        result = await asyncio.to_thread(recognize_position, raw)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Recognition failed: {exc}") from exc
    return {
        "fen": result.fen,
        "confidence": result.confidence,
        "method": result.method,
        "notes": result.notes,
    }


@app.post("/api/game/import")
async def game_import(req: GameImportRequest) -> dict[str, Any]:
    try:
        imported = await import_game_async(req.source)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Import failed: {exc}") from exc
    return imported.to_dict()


@app.get("/api/opening/explorer")
async def opening_explorer(fen: str, limit: int = 5) -> dict[str, Any]:
    """Top master replies for the given position (via Lichess Masters)."""
    from .opening_book import masters_top_moves
    moves = await masters_top_moves(fen, limit=limit)
    return {"moves": moves}


@app.post("/api/game/analyse")
async def game_analyse(req: GameAnalyseRequest) -> dict[str, Any]:
    if not engine.is_running:
        raise HTTPException(status_code=409, detail="Engine not configured.")
    try:
        result = await analyse_game(
            moves_uci=req.moves_uci,
            starting_fen=req.starting_fen,
            movetime_ms=req.movetime_ms,
            depth=req.depth,
            multipv=req.multipv,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    return result


# ---- Puzzles ----

# Puzzle / users endpoints below are declared as `def` (not `async def`) on
# purpose: FastAPI runs sync endpoints inside its threadpool, so the SQLite
# / users.json calls don't block the event loop. With `async def` a slow
# random_puzzle (5.5M-row scan) would freeze concurrent requests like
# /api/users/upsert — which is exactly the "Загружаю профиль…" hang we hit
# while a puzzle was loading.

@app.get("/api/puzzle/stats")
def puzzle_stats() -> dict[str, Any]:
    """Pack-level metadata: counts, difficulty bands, theme labels."""
    return puzzles_db.stats()


@app.get("/api/puzzle/random")
def puzzle_random(
    difficulty: str | None = None,
    theme: str | None = None,
    min_rating: int | None = None,
    max_rating: int | None = None,
    exclude: str | None = None,
) -> dict[str, Any]:
    """Return a single random puzzle matching the optional filters.

    `exclude` is a comma-separated list of recently-served puzzle ids
    so the frontend can avoid showing the same puzzle twice in a row.
    """
    diff = difficulty.lower() if difficulty else None
    if diff and diff not in ("easy", "medium", "hard"):
        raise HTTPException(status_code=400, detail="difficulty must be easy/medium/hard")
    exclude_ids = set(filter(None, (exclude or "").split(","))) or None
    p = puzzles_db.random_puzzle(
        difficulty=diff,
        theme=theme or None,
        min_rating=min_rating,
        max_rating=max_rating,
        exclude_ids=exclude_ids,
    )
    if not p:
        # Fall back to ignoring filters rather than 404-ing.
        p = puzzles_db.random_puzzle()
    if not p:
        raise HTTPException(status_code=404, detail="No puzzles available.")
    return _serialize_puzzle(p)


@app.get("/api/puzzle/{puzzle_id}")
def puzzle_by_id(puzzle_id: str) -> dict[str, Any]:
    p = puzzles_db.get_by_id(puzzle_id)
    if not p:
        raise HTTPException(status_code=404, detail="Puzzle not found.")
    return _serialize_puzzle(p)


def _serialize_puzzle(p: dict[str, Any]) -> dict[str, Any]:
    """Project a puzzle into the shape the frontend expects."""
    moves = list(p.get("moves") or [])
    fen = str(p.get("fen") or "")
    # Determine which side will be solving by playing the opponent's
    # setup move on the FEN — chess library handles SAN/UCI parsing.
    side_to_solve: str | None = None
    setup_san: str | None = None
    try:
        board = chess.Board(fen)
        if moves:
            mv = chess.Move.from_uci(moves[0])
            if mv in board.legal_moves:
                setup_san = board.san(mv)
        # The solver's side is the side that plays moves[1]. Lichess
        # encodes this so the side-to-move at the *start* of the
        # puzzle is the opponent.
        side_to_solve = "b" if board.turn == chess.WHITE else "w"
    except (ValueError, chess.InvalidMoveError, chess.IllegalMoveError):
        pass
    themes = list(p.get("themes") or [])
    labels = puzzles_db.theme_labels()
    themes_ru = [labels.get(t, t) for t in themes]
    return {
        "id": p.get("id"),
        "fen": fen,
        "moves": moves,
        "rating": int(p.get("rating") or 0),
        "popularity": int(p.get("popularity") or 0),
        "plays": int(p.get("plays") or 0),
        "themes": themes,
        "themes_ru": themes_ru,
        "url": p.get("url"),
        "difficulty": puzzles_db.difficulty_band(p),
        "side_to_solve": side_to_solve,
        "setup_san": setup_san,
    }


def _result_to_dict(result: Any) -> dict[str, Any]:
    return {
        "best_move": result.best_move_uci,
        "ponder": result.ponder_uci,
        "score_cp": result.score_cp,
        "score_mate": result.score_mate,
        "depth": result.depth,
        "pv": result.pv,
    }


# ---- Users / Profile / Leaderboard ----

@app.post("/api/users/upsert")
def users_upsert(req: UserUpsertRequest) -> dict[str, Any]:
    """Register or update profile for a given client_id."""
    return users_db.upsert_user(
        client_id=req.client_id,
        nickname=req.nickname,
        avatar=req.avatar,
    )


# ---- Avatar upload / serve ----
#
# Custom photos are stored on disk under ``data_dir/avatars/<cid>.png``.
# We always re-encode through Pillow into PNG so:
#   • untrusted SVG/animated content can't be hand-rolled past us,
#   • output is bounded in pixels (max 256×256) and uniformly sized.
# The path returned in the user row contains a cache-busting query
# string so the client always re-fetches after an upload.

_AVATAR_DIR = settings.data_dir / "avatars"
_AVATAR_MAX_BYTES = 4 * 1024 * 1024  # 4 MB hard cap on the upload itself
_AVATAR_MAX_PX = 256


def _avatar_path(client_id: str) -> Path:
    safe = "".join(ch for ch in client_id if ch.isalnum() or ch in ("-", "_"))[:64]
    if not safe:
        raise HTTPException(status_code=400, detail="Bad client_id.")
    return _AVATAR_DIR / f"{safe}.png"


@app.post("/api/users/avatar")
async def users_avatar_upload(
    file: Annotated[UploadFile, File(...)],
    client_id: str = Query(..., min_length=4, max_length=64),
) -> dict[str, Any]:
    """Accept a multipart image, normalise it to a 256×256 PNG, persist."""
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty upload.")
    if len(raw) > _AVATAR_MAX_BYTES:
        raise HTTPException(status_code=413, detail="Image too large (max 4MB).")
    try:
        from PIL import Image, UnidentifiedImageError
        from PIL.Image import Image as PILImage

        try:
            im: PILImage = Image.open(BytesIO(raw))
            im.load()
        except UnidentifiedImageError as exc:
            raise HTTPException(status_code=415, detail="Unsupported image type.") from exc
        # Normalise mode and centre-crop to a square.
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA")
        side = min(im.width, im.height)
        if side <= 0:
            raise HTTPException(status_code=400, detail="Image has zero dimension.")
        left = (im.width - side) // 2
        top = (im.height - side) // 2
        im = im.crop((left, top, left + side, top + side))
        if im.width > _AVATAR_MAX_PX:
            im = im.resize(
                (_AVATAR_MAX_PX, _AVATAR_MAX_PX),
                Image.Resampling.LANCZOS,
            )
        out = BytesIO()
        im.save(out, format="PNG", optimize=True)
        encoded = out.getvalue()
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("avatar upload: failed to decode/encode")
        raise HTTPException(status_code=400, detail="Bad image.") from exc

    target = _avatar_path(client_id)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(encoded)

    url = f"/api/avatars/{target.name}?v={int(time.time())}"
    updated = users_db.set_avatar(client_id, url)
    if updated is None:
        # User row didn't exist yet — surface a sensible reply with the
        # URL so the client can post a follow-up upsert with this avatar
        # value once the row gets created.
        return {"avatar": url, "user": None}
    return {"avatar": url, "user": updated}


@app.delete("/api/users/avatar")
def users_avatar_delete(
    client_id: str = Query(..., min_length=4, max_length=64),
) -> dict[str, Any]:
    """Remove the custom photo and revert the avatar to a default glyph."""
    target = _avatar_path(client_id)
    try:
        target.unlink(missing_ok=True)
    except OSError:
        pass
    updated = users_db.set_avatar(client_id, "♟")
    return {"avatar": "♟", "user": updated}


@app.post("/api/users/heartbeat")
def users_heartbeat(req: HeartbeatRequest) -> dict[str, Any]:
    users_db.heartbeat(req.client_id)
    return {"ok": True}


@app.get("/api/users")
def users_list() -> dict[str, Any]:
    return {"users": users_db.list_users()}


@app.get("/api/users/{client_id}")
def users_get(client_id: str) -> dict[str, Any]:
    u = users_db.get_user(client_id)
    if not u:
        raise HTTPException(status_code=404, detail="User not found.")
    return u


@app.post("/api/users/puzzle_attempt")
def users_puzzle_attempt(req: PuzzleAttemptRequest) -> dict[str, Any]:
    # Look up the authoritative puzzle rating from the bank if the client
    # supplied a puzzle_id — that way we don't trust the client's number
    # and a tampered request can't pretend a 2800 puzzle was solved.
    canonical_rating: int | None = None
    if req.puzzle_id:
        p = puzzles_db.get_by_id(req.puzzle_id)
        if p:
            canonical_rating = int(p.get("rating") or 0)
    u = users_db.record_puzzle_attempt(
        client_id=req.client_id,
        outcome=req.outcome,
        puzzle_id=req.puzzle_id,
        puzzle_rating=canonical_rating,
        solve_ms=req.solve_ms,
    )
    if not u:
        raise HTTPException(status_code=400, detail="Bad outcome.")
    return u


# NOTE: /api/users/party_result was removed. Party results are written
# into a user's history server-side from `Party.finish()` — exposing an
# HTTP endpoint that took the placement / elo_gained from the client
# meant any caller could `curl` a fake "I won, +500 ELO" entry into
# their own profile. The server-side path remains the only way to
# append to `parties[]`.


# ---- Puzzle Rush ----

@app.post("/api/puzzle_rush/start")
def puzzle_rush_start(req: PuzzleRushStartRequest) -> dict[str, Any]:
    if req.mode not in puzzle_rush_room.MODE_DURATION_SEC:
        raise HTTPException(status_code=400, detail="mode must be 3min|5min|survival")
    try:
        return puzzle_rush_room.start_session(client_id=req.client_id, mode=req.mode)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/puzzle_rush/attempt")
def puzzle_rush_attempt(req: PuzzleRushAttemptRequest) -> dict[str, Any]:
    if req.outcome not in ("solved", "failed", "skipped"):
        raise HTTPException(status_code=400, detail="outcome must be solved|failed|skipped")
    try:
        return puzzle_rush_room.attempt(
            session_id=req.session_id,
            client_id=req.client_id,
            puzzle_id=req.puzzle_id,
            outcome=req.outcome,
            solve_ms=req.solve_ms,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/puzzle_rush/finalize")
def puzzle_rush_finalize(req: PuzzleRushFinalizeRequest) -> dict[str, Any]:
    try:
        return puzzle_rush_room.finalize(
            session_id=req.session_id, client_id=req.client_id
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.get("/api/puzzle_rush/state")
def puzzle_rush_state(
    session_id: str = Query(..., min_length=4, max_length=64),
    client_id: str = Query(..., min_length=4, max_length=64),
) -> dict[str, Any]:
    try:
        return puzzle_rush_room.get_state(session_id=session_id, client_id=client_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@app.get("/api/puzzle_rush/leaderboard")
def puzzle_rush_leaderboard(
    mode: str = Query(..., description="3min | 5min | survival"),
    period: str = Query(default="all", description="all | today"),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict[str, Any]:
    if mode not in puzzle_rush_room.MODE_DURATION_SEC:
        raise HTTPException(status_code=400, detail="mode must be 3min|5min|survival")
    if period not in ("all", "today"):
        raise HTTPException(status_code=400, detail="period must be all|today")
    return {
        "mode": mode,
        "period": period,
        "rows": users_db.puzzle_rush_leaderboard(mode=mode, period=period, limit=limit),
    }


# ---- Daily Puzzle ----

@app.get("/api/daily_puzzle/today")
def daily_puzzle_today() -> dict[str, Any]:
    date = daily_puzzle_pack.today_iso()
    p = daily_puzzle_pack.get_for_date(date)
    if not p:
        raise HTTPException(status_code=503, detail="No puzzle available for today.")
    payload = daily_puzzle_pack.public_payload(p, date=date)
    serialized = _serialize_puzzle(p)
    payload["side_to_solve"] = serialized.get("side_to_solve")
    payload["setup_san"] = serialized.get("setup_san")
    payload["themes_ru"] = serialized.get("themes_ru") or []
    return payload


@app.post("/api/daily_puzzle/attempt")
def daily_puzzle_attempt(req: DailyPuzzleAttemptRequest) -> dict[str, Any]:
    if req.outcome not in ("solved", "failed"):
        raise HTTPException(status_code=400, detail="outcome must be solved|failed")
    expected = daily_puzzle_pack.get_for_date(req.date)
    if not expected or str(expected.get("id") or "") != req.puzzle_id:
        raise HTTPException(status_code=400, detail="puzzle_id does not match the daily puzzle")
    u = users_db.record_daily_puzzle_attempt(
        req.client_id,
        date=req.date,
        puzzle_id=req.puzzle_id,
        outcome=req.outcome,
        solve_ms=req.solve_ms,
    )
    if u is None:
        raise HTTPException(status_code=404, detail="User not found.")
    return u


@app.get("/api/daily_puzzle/leaderboard")
def daily_puzzle_leaderboard(
    date: str | None = Query(default=None, description="ISO date YYYY-MM-DD; defaults to today UTC"),
    limit: int = Query(default=100, ge=1, le=500),
) -> dict[str, Any]:
    target = date or daily_puzzle_pack.today_iso()
    return {
        "date": target,
        "rows": users_db.daily_puzzle_leaderboard(target, limit=limit),
    }


# ---- Opening Trainer ----

@app.get("/api/opening_trainer/list")
def opening_trainer_list() -> dict[str, Any]:
    return {"openings": opening_trainer_pack.list_openings()}


@app.get("/api/opening_trainer/{opening_id}")
def opening_trainer_get(opening_id: str) -> dict[str, Any]:
    op = opening_trainer_pack.get_opening(opening_id)
    if op is None:
        raise HTTPException(status_code=404, detail="Opening not found.")
    return op.to_dict()


@app.get("/api/opening_trainer/{opening_id}/position")
def opening_trainer_position(
    opening_id: str,
    ply: int = Query(default=0, ge=0, le=64),
) -> dict[str, Any]:
    try:
        return opening_trainer_pack.position_at(opening_id, ply)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.post("/api/opening_trainer/attempt")
def opening_trainer_attempt(req: OpeningAttemptRequest) -> dict[str, Any]:
    try:
        evaluation = opening_trainer_pack.evaluate_move(
            opening_id=req.opening_id,
            ply=req.ply,
            san=req.san,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except IndexError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    user = users_db.record_opening_attempt(
        req.client_id,
        opening_id=req.opening_id,
        correct=bool(evaluation.get("correct")),
        line_completed=bool(evaluation.get("finished")),
    )
    return {
        "evaluation": evaluation,
        "user": user,
    }


@app.get("/api/opening_trainer/leaderboard")
def opening_trainer_leaderboard(
    limit: int = Query(default=100, ge=1, le=500),
) -> dict[str, Any]:
    return {"rows": users_db.opening_trainer_leaderboard(limit=limit)}


# ---- Coach status stubs (AI removed) ----
#
# The previous build shipped an Ollama + Stockfish "AI coach" for the
# Opening Trainer and the Game Review. The user explicitly asked us to
# strip every AI surface from the project, so the coach endpoints below
# now return a fixed `available: false` payload. The real chess.com-
# style explanations are produced entirely on the frontend now from a
# large hardcoded phrase bank (see `COACH_HEADLINES` / `COACH_IDEAS` in
# `frontend/app.js`).


def _coach_status_stub() -> dict[str, Any]:
    """Shape-compatible reply for the legacy coach status probes.

    Old clients that still poll `/api/opening_trainer/coach/status` or
    `/api/analysis/coach/status` will read `available: false` and
    silently skip showing any AI button — same fallback path they had
    when Ollama was off.
    """
    return {
        "available": False,
        "model": "",
        "base_url": "",
        "installed_models": [],
        "stockfish_running": engine.is_running,
    }


@app.get("/api/opening_trainer/coach/status")
async def opening_trainer_coach_status() -> dict[str, Any]:
    return _coach_status_stub()


@app.get("/api/analysis/coach/status")
async def analysis_coach_status() -> dict[str, Any]:
    return _coach_status_stub()


# ---- Party / Co-op puzzles ----

class PartyCreateRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)
    nickname: str = Field(default="Гость", max_length=32)
    # `avatar` may be a glyph (e.g. "♟") or a URL pointing at the static
    # avatars mount (e.g. "/api/avatars/<cid>.png?v=<ts>"), so the cap
    # mirrors UserUpsertRequest at 256 chars.
    avatar: str = Field(default="♟", max_length=256)
    # Puzzle-rating mode picked by the host on the lobby screen:
    #   "standard" — server picks puzzles around the lobby's average ELO
    #   "custom"   — host explicitly types a [rating_min, rating_max]
    # If `mode == "custom"` then both `rating_min` and `rating_max` must
    # be set; otherwise both are ignored. Both bounds are clipped to
    # ``PARTY_BAND_MIN..PARTY_BAND_MAX`` server-side so a tampered
    # payload can't request a 0-rated bank.
    mode: str = Field(default="standard", max_length=16)
    rating_min: int = Field(default=0, ge=0, le=4000)
    rating_max: int = Field(default=0, ge=0, le=4000)
    # Match kind picked by the host: "solo" (legacy free-for-all) or
    # "party" (team A vs team B, score-sum). Defaults to "solo" so
    # existing clients keep working without any payload changes.
    kind: str = Field(default="solo", max_length=16)


@app.post("/api/party/create")
async def party_create(req: PartyCreateRequest) -> dict[str, Any]:
    party_room.reap_idle()
    p = await party_room.create_party(
        req.client_id,
        req.nickname,
        req.avatar,
        kind=req.kind,
    )
    # Persist the host-picked mode + rating window onto the freshly
    # created Party. We do it *outside* `create_party()` so the helper
    # signature stays generic for tests; the mode round-trips through
    # `public_state()` so the lobby UI can show the badge to everyone.
    mode = (req.mode or "standard").strip().lower()
    if mode not in ("standard", "custom"):
        mode = "standard"
    p.mode = mode
    if mode == "custom":
        lo = int(req.rating_min or 0)
        hi = int(req.rating_max or 0)
        if lo > 0 and hi > 0 and lo < hi:
            p.rating_min = lo
            p.rating_max = hi
        else:
            # Invalid window — silently fall back to standard so the
            # host doesn't lose the lobby on a typo. The frontend
            # validates as well.
            p.mode = "standard"
            p.rating_min = 0
            p.rating_max = 0
    else:
        p.rating_min = 0
        p.rating_max = 0
    return {"party_id": p.party_id, "code": p.code, **p.public_state()}


@app.get("/api/party/list")
async def party_list() -> dict[str, Any]:
    party_room.reap_idle()
    return {"parties": party_room.list_open()}


@app.post("/api/party/invite")
async def party_invite(req: PartyInviteRequest) -> dict[str, Any]:
    p = party_room.get_party(req.code)
    if not p:
        raise HTTPException(status_code=404, detail="Party not found.")
    if p.host_id != req.client_id:
        raise HTTPException(status_code=403, detail="Only the host can invite.")
    target = users_db.get_user(req.target_id)
    if not target:
        raise HTTPException(status_code=404, detail="Target user not found.")
    host = users_db.get_user(req.client_id)
    inv = await notifications_db.create_invitation(
        host_id=req.client_id,
        host_nickname=(host or {}).get("nickname") or "Гость",
        host_avatar=(host or {}).get("avatar") or "♟",
        target_id=req.target_id,
        party_code=p.code,
        party_id=p.party_id,
    )
    return {"invitation": inv.public()}


@app.get("/api/party/invitations")
async def party_invitations(
    client_id: str = Query(..., min_length=4, max_length=64),
) -> dict[str, Any]:
    return {"invitations": notifications_db.pending_invitations_for(client_id)}


@app.post("/api/party/invitations/{invite_id}/accept")
async def party_invitation_accept(invite_id: str, req: InviteActionRequest) -> dict[str, Any]:
    inv = await notifications_db.accept_invitation(invite_id, req.client_id)
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found or not yours.")
    return {"invitation": inv.public(), "code": inv.party_code}


@app.post("/api/party/invitations/{invite_id}/decline")
async def party_invitation_decline(invite_id: str, req: InviteActionRequest) -> dict[str, Any]:
    inv = await notifications_db.decline_invitation(invite_id, req.client_id)
    if inv is None:
        raise HTTPException(status_code=404, detail="Invitation not found or not yours.")
    return {"invitation": inv.public()}


# NOTE: this catch-all ``/{code}`` route MUST come *after* the more
# specific party endpoints above (``invite``, ``invitations``,
# ``list``) so FastAPI's path matcher doesn't swallow them.
@app.get("/api/party/{code}")
async def party_state(code: str) -> dict[str, Any]:
    p = party_room.get_party(code)
    if not p:
        raise HTTPException(status_code=404, detail="Party not found.")
    return p.public_state()


@app.get("/api/notifications/stream")
async def notifications_stream(
    client_id: str = Query(..., min_length=4, max_length=64),
) -> StreamingResponse:
    """Server-Sent Events stream of per-user notifications.

    The browser opens an EventSource on this endpoint after the user is
    bootstrapped; the server pushes JSON-encoded `data:` lines whenever
    something happens to that user (party invitations, accept/decline
    feedback to the host, etc).
    """
    sub = await notifications_db.subscribe(client_id)

    async def event_gen() -> Any:
        try:
            # Send a hello frame with any pending invitations so the
            # client doesn't have to do a separate REST call on boot.
            hello = {
                "type": "hello",
                "invitations": notifications_db.pending_invitations_for(client_id),
                "engine": engine.current_state(),
            }
            yield f"data: {json.dumps(hello)}\n\n"
            while True:
                try:
                    payload = await asyncio.wait_for(sub.queue.get(), timeout=20.0)
                    yield f"data: {json.dumps(payload)}\n\n"
                except asyncio.TimeoutError:
                    # Heartbeat to keep proxies (ngrok, Cloudflare,
                    # nginx) from dropping idle connections.
                    yield ": ping\n\n"
        finally:
            await notifications_db.unsubscribe(sub)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.websocket("/api/party/ws/{code}")
async def party_ws(ws: WebSocket, code: str) -> None:
    client_id = ws.query_params.get("client_id") or ""
    nickname = ws.query_params.get("nickname") or ""
    avatar = ws.query_params.get("avatar") or ""
    theme = ws.query_params.get("theme") or ""
    pieces = ws.query_params.get("pieces") or ""
    legal_color = ws.query_params.get("legal_color") or ""
    role = (ws.query_params.get("role") or "player").lower()
    if not client_id or len(client_id) < 4:
        await ws.close(code=4400)
        return
    party = party_room.get_party(code)
    if not party:
        await ws.close(code=4404)
        return
    await ws.accept()
    if role == "spectator":
        await _party_ws_spectator(ws, party, client_id, nickname, avatar)
    else:
        await _party_ws_player(
            ws, party, client_id, nickname, avatar, theme, pieces, legal_color,
        )


async def _party_ws_player(
    ws: WebSocket,
    party: party_room.Party,
    client_id: str,
    nickname: str,
    avatar: str,
    theme: str,
    pieces: str,
    legal_color: str,
) -> None:
    try:
        await party.attach(
            client_id,
            nickname,
            avatar,
            ws,
            theme=theme,
            pieces=pieces,
            legal_color=legal_color,
        )
    except party_room.PartyError as e:
        await ws.send_json({"type": "error", "code": e.code, "message": e.message})
        await ws.close(code=4400)
        return
    explicit_leave = False
    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "start":
                # `duration_sec` is fixed at 180 server-side, but we
                # still accept it on the wire so legacy clients don't
                # error out. `mode` / `rating_min` / `rating_max` let
                # the host switch the puzzle-rating window at start
                # time without recreating the lobby.
                duration_sec = msg.get("duration_sec")
                mode = msg.get("mode")
                rating_min = msg.get("rating_min")
                rating_max = msg.get("rating_max")
                try:
                    await party.start(
                        client_id,
                        duration_sec=duration_sec,
                        mode=str(mode) if mode is not None else None,
                        rating_min=int(rating_min) if rating_min is not None else None,
                        rating_max=int(rating_max) if rating_max is not None else None,
                    )
                except party_room.PartyError as e:
                    await ws.send_json({"type": "error", "code": e.code, "message": e.message})
            elif mtype == "attempt":
                await party.attempt(
                    client_id,
                    puzzle_id=str(msg.get("puzzle_id") or ""),
                    outcome=str(msg.get("outcome") or "skipped"),
                    solve_ms=int(msg.get("solve_ms") or 0),
                )
            elif mtype == "position":
                # Mid-puzzle FEN update for spectators. The player also
                # forwards their current orientation + last applied move
                # so watchers see the same board the player sees. The
                # review-badge fields mirror the ✓/✗ icon and from→to
                # colour tint the solver paints locally — without these
                # Battle spectators saw an FEN update with no badge or
                # colour, so wrong moves looked the same as right ones.
                await party.update_position(
                    client_id,
                    str(msg.get("fen") or ""),
                    flipped=bool(msg.get("flipped")) if "flipped" in msg else None,
                    last_move=str(msg.get("last_move") or "") if "last_move" in msg else None,
                    review_badge_square=str(
                        msg.get("review_badge_square") or "",
                    ) if "review_badge_square" in msg else None,
                    review_badge_kind=str(
                        msg.get("review_badge_kind") or "",
                    ) if "review_badge_kind" in msg else None,
                )
            elif mtype == "cursor":
                # Pointer / drag relay for spectators.
                await party.relay_cursor(
                    client_id,
                    msg.get("x", 0),
                    msg.get("y", 0),
                    flipped=bool(msg.get("flipped")),
                    selected=str(msg.get("selected") or "") or None,
                    dragging=bool(msg.get("dragging")),
                    drag_piece=str(msg.get("drag_piece") or "") or None,
                    drag_from=str(msg.get("drag_from") or "") or None,
                )
            elif mtype == "select":
                # Player started/cleared a selection (click or drag).
                # Spectators replicate the same hint dots / rings the
                # player sees on candidate squares.
                await party.update_selection(
                    client_id,
                    from_sq=msg.get("from"),
                    piece=msg.get("piece"),
                    legal_moves=msg.get("legal_moves"),
                    legal_captures=msg.get("legal_captures"),
                    legal_color=msg.get("legal_color"),
                )
            elif mtype == "chat":
                # Player-authored chat. ``party.chat`` rate-limits and
                # sanitises; it returns ``None`` for rejected lines and
                # we silently drop those (no error reply — a stuck UI
                # button would otherwise see a feedback storm).
                entry = await party.chat(client_id, str(msg.get("text") or ""))
                if entry is not None:
                    await party.broadcast(entry)
            elif mtype == "reaction":
                entry = await party.react(client_id, str(msg.get("code") or ""))
                if entry is not None:
                    await party.broadcast(entry)
            elif mtype == "set_kind":
                # Party Mode: host toggles between solo (free-for-all)
                # and party (team A vs team B). The new kind is
                # broadcast as a fresh ``lobby`` event so every
                # connected client repaints the picker + team grid.
                try:
                    party.set_kind(client_id, str(msg.get("kind") or ""))
                    await party.broadcast({"type": "lobby", **party.public_state()})
                except party_room.PartyError as e:
                    await ws.send_json({"type": "error", "code": e.code, "message": e.message})
            elif mtype == "set_team":
                # Party Mode: members move themselves to A/B/None; the
                # host can move anybody. Side-effect: re-broadcast the
                # full lobby state so the team-grid totals + the per-
                # team capacity warnings stay in sync everywhere.
                target = str(msg.get("client_id") or client_id)
                team_raw = msg.get("team")
                team_val: str | None
                if team_raw is None or team_raw == "":
                    team_val = None
                else:
                    team_val = str(team_raw)
                try:
                    party.set_team(client_id, target, team_val)
                    await party.broadcast({"type": "lobby", **party.public_state()})
                except party_room.PartyError as e:
                    await ws.send_json({"type": "error", "code": e.code, "message": e.message})
            elif mtype == "balance_teams":
                # Host-only: re-shuffle members round-robin across A/B
                # so a lobby that organically ended up 6-vs-2 becomes
                # 4-vs-4 instantly. The host clicks "Auto-balance" and
                # then everyone repaints from the broadcast.
                try:
                    party.balance_teams(client_id)
                    await party.broadcast({"type": "lobby", **party.public_state()})
                except party_room.PartyError as e:
                    await ws.send_json({"type": "error", "code": e.code, "message": e.message})
            elif mtype == "ping":
                await ws.send_json({"type": "pong"})
            elif mtype == "leave":
                explicit_leave = True
                # Hard-remove if still in lobby; mid-match calls fall
                # through to detach in the finally block.
                await party.leave(client_id)
                await ws.close()
                break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("party ws error: %s", exc)
    finally:
        if not explicit_leave:
            await party.detach(client_id)


async def _party_ws_spectator(
    ws: WebSocket,
    party: party_room.Party,
    client_id: str,
    nickname: str,
    avatar: str,
) -> None:
    try:
        await party.attach_spectator(client_id, nickname, avatar, ws)
    except Exception as exc:
        logger.warning("party spectator attach error: %s", exc)
        await ws.close(code=4400)
        return
    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                await ws.send_json({"type": "pong"})
            elif mtype == "leave":
                await ws.close()
                break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("party spectator ws error: %s", exc)
    finally:
        await party.detach_spectator(client_id)


# ---- Solo presence (live spectating outside parties) ----


@app.get("/api/presence/list")
async def presence_list() -> dict[str, Any]:
    """Discovery list for the 'Оффлайн' tab — solo puzzle players who
    are currently live and broadcasting. Excludes the caller? No, the
    caller filters themselves on the frontend so the same list works
    for everyone without authenticating the request here."""
    return {"players": presence_room.list_active()}


@app.websocket("/api/presence/ws")
async def presence_ws(ws: WebSocket) -> None:
    """Single endpoint that handles both player-broadcast and
    spectator-attach traffic, distinguished by the ``role`` query
    parameter. Player connections register their solo session;
    spectator connections subscribe to a specific player by
    ``watch=<client_id>``."""
    client_id = ws.query_params.get("client_id") or ""
    role = (ws.query_params.get("role") or "player").lower()
    nickname = ws.query_params.get("nickname") or ""
    avatar = ws.query_params.get("avatar") or ""
    if not client_id or len(client_id) < 4:
        await ws.close(code=4400)
        return
    await ws.accept()
    if role == "spectator":
        target = ws.query_params.get("watch") or ""
        if not target:
            await ws.send_json({"type": "error", "code": "no_target"})
            await ws.close(code=4400)
            return
        await _presence_ws_spectator(ws, spectator_id=client_id, target=target)
    else:
        theme = ws.query_params.get("theme") or ""
        pieces = ws.query_params.get("pieces") or ""
        legal_color = ws.query_params.get("legal_color") or ""
        try:
            rating = int(ws.query_params.get("rating") or 0)
        except (TypeError, ValueError):
            rating = 0
        await _presence_ws_player(
            ws,
            client_id=client_id,
            nickname=nickname,
            avatar=avatar,
            theme=theme,
            pieces=pieces,
            legal_color=legal_color,
            rating=rating,
        )


async def _presence_ws_player(
    ws: WebSocket,
    *,
    client_id: str,
    nickname: str,
    avatar: str,
    theme: str,
    pieces: str,
    legal_color: str,
    rating: int,
) -> None:
    await presence_room.attach_player(
        ws,
        client_id=client_id,
        nickname=nickname,
        avatar=avatar,
        theme=theme,
        pieces=pieces,
        legal_color=legal_color,
        rating=rating,
    )
    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "position":
                await presence_room.update_position(
                    client_id,
                    str(msg.get("fen") or ""),
                    flipped=bool(msg.get("flipped"))
                    if "flipped" in msg
                    else None,
                    last_move=str(msg.get("last_move") or "")
                    if "last_move" in msg
                    else None,
                    puzzle_id=str(msg.get("puzzle_id") or "")
                    if "puzzle_id" in msg
                    else None,
                    puzzle_rating=int(msg.get("puzzle_rating") or 0)
                    if "puzzle_rating" in msg
                    else None,
                    streak=int(msg.get("streak") or 0)
                    if "streak" in msg
                    else None,
                    best_streak=int(msg.get("best_streak") or 0)
                    if "best_streak" in msg
                    else None,
                    rating=int(msg.get("rating") or 0)
                    if "rating" in msg
                    else None,
                    review_badge_square=str(
                        msg.get("review_badge_square") or "",
                    ) if "review_badge_square" in msg else None,
                    review_badge_kind=str(
                        msg.get("review_badge_kind") or "",
                    ) if "review_badge_kind" in msg else None,
                    mode=str(msg.get("mode") or "")
                    if "mode" in msg
                    else None,
                )
            elif mtype == "select":
                await presence_room.update_selection(
                    client_id,
                    from_sq=msg.get("from"),
                    piece=msg.get("piece"),
                    legal_moves=msg.get("legal_moves"),
                    legal_captures=msg.get("legal_captures"),
                    legal_color=msg.get("legal_color"),
                )
            elif mtype == "cursor":
                await presence_room.relay_cursor(
                    client_id,
                    msg.get("x", 0),
                    msg.get("y", 0),
                    flipped=bool(msg.get("flipped")),
                    selected=str(msg.get("selected") or "") or None,
                    dragging=bool(msg.get("dragging")),
                    drag_piece=str(msg.get("drag_piece") or "") or None,
                    drag_from=str(msg.get("drag_from") or "") or None,
                )
            elif mtype == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("presence player ws error: %s", exc)
    finally:
        await presence_room.detach_player(client_id)


async def _presence_ws_spectator(
    ws: WebSocket, *, spectator_id: str, target: str,
) -> None:
    presence = await presence_room.attach_spectator(
        ws, spectator_id=spectator_id, target_client_id=target,
    )
    if presence is None:
        try:
            await ws.send_json({"type": "presence_gone", "client_id": target})
        except Exception:
            pass
        await ws.close(code=4404)
        return
    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "ping":
                await ws.send_json({"type": "pong"})
            elif mtype == "leave":
                await ws.close()
                break
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("presence spectator ws error: %s", exc)
    finally:
        await presence_room.detach_spectator(target, spectator_id)


# ---- 1 vs 1 mode (legal-move challenges + live match relay) ----


@app.post("/api/onevsone/challenge")
async def onevsone_challenge(payload: OneVsOneChallengeRequest) -> dict[str, Any]:
    """Send a 1v1 challenge from ``client_id`` to ``target_id``. The
    target receives a ``onevsone_challenge`` notification on the SSE
    pipe; the response carries the persisted record so the challenger
    can show "Awaiting reply…" UI."""
    challenger = users_db.get_user(payload.client_id)
    target = users_db.get_user(payload.target_id)
    if challenger is None or target is None:
        raise HTTPException(status_code=404, detail="user_not_found")
    try:
        ch = await onevsone_room.create_challenge(
            challenger_id=str(challenger.get("client_id") or payload.client_id),
            challenger_nickname=str(challenger.get("nickname") or ""),
            challenger_avatar=str(challenger.get("avatar") or ""),
            target_id=str(target.get("client_id") or payload.target_id),
            target_nickname=str(target.get("nickname") or ""),
            time_seconds=payload.time_seconds,
            increment_seconds=payload.increment_seconds,
            challenger_color=payload.challenger_color,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"challenge": ch.public()}


@app.get("/api/onevsone/challenges")
async def onevsone_pending_challenges(
    client_id: str = Query(..., min_length=4, max_length=64),
) -> dict[str, Any]:
    """Return any pending 1v1 challenges targeted at ``client_id``."""
    return {"challenges": onevsone_room.pending_challenges_for(client_id)}


@app.post("/api/onevsone/challenge/{challenge_id}/accept")
async def onevsone_challenge_accept(
    challenge_id: str, payload: OneVsOneActionRequest,
) -> dict[str, Any]:
    user = users_db.get_user(payload.client_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user_not_found")
    user_cid = str(user.get("client_id") or payload.client_id)
    result = await onevsone_room.accept_challenge(
        challenge_id,
        user_cid,
        str(user.get("nickname") or ""),
        str(user.get("avatar") or ""),
    )
    if result is None:
        raise HTTPException(status_code=404, detail="challenge_not_found_or_invalid")
    ch, match = result
    return {"challenge": ch.public(), "match": match.public(user_cid)}


@app.post("/api/onevsone/challenge/{challenge_id}/decline")
async def onevsone_challenge_decline(
    challenge_id: str, payload: OneVsOneActionRequest,
) -> dict[str, Any]:
    ch = await onevsone_room.decline_challenge(challenge_id, payload.client_id)
    if ch is None:
        raise HTTPException(status_code=404, detail="challenge_not_found_or_invalid")
    return {"challenge": ch.public()}


@app.post("/api/onevsone/challenge/{challenge_id}/cancel")
async def onevsone_challenge_cancel(
    challenge_id: str, payload: OneVsOneActionRequest,
) -> dict[str, Any]:
    ch = await onevsone_room.cancel_challenge(challenge_id, payload.client_id)
    if ch is None:
        raise HTTPException(status_code=404, detail="challenge_not_found_or_invalid")
    return {"challenge": ch.public()}


@app.get("/api/onevsone/match/{match_id}")
async def onevsone_match_state(
    match_id: str,
    client_id: str = Query(..., min_length=4, max_length=64),
) -> dict[str, Any]:
    m = onevsone_room.get_match(match_id)
    if m is None:
        raise HTTPException(status_code=404, detail="match_not_found")
    if m.player_for(client_id) is None:
        raise HTTPException(status_code=403, detail="not_a_player")
    return {"match": m.public(client_id)}


@app.get("/api/onevsone/active")
async def onevsone_active_match(
    client_id: str = Query(..., min_length=4, max_length=64),
) -> dict[str, Any]:
    """Return the caller's currently active match (if any) so a player
    whose page reloaded mid-game — or who never received the
    ``onevsone_match`` notification because their SSE stream hiccupped
    — can re-enter their live match instead of being stuck in the
    lobby."""
    m = onevsone_room.find_active_match(client_id)
    if m is None:
        return {"match": None}
    return {"match": m.public(client_id)}


@app.post("/api/onevsone/match/{match_id}/draw_offer")
async def onevsone_match_draw_offer(
    match_id: str, payload: OneVsOneActionRequest,
) -> dict[str, Any]:
    result = await onevsone_room.offer_draw(match_id, payload.client_id)
    if result is None:
        raise HTTPException(status_code=404, detail="match_not_found_or_finished")
    m = onevsone_room.get_match(match_id)
    if m is not None and not result.get("already"):
        await _onevsone_broadcast(m, {
            "type": "draw_offer",
            "by": payload.client_id,
        })
    return result


@app.post("/api/onevsone/match/{match_id}/draw_accept")
async def onevsone_match_draw_accept(
    match_id: str, payload: OneVsOneActionRequest,
) -> dict[str, Any]:
    result = await onevsone_room.accept_draw(match_id, payload.client_id)
    if result is None:
        raise HTTPException(status_code=404, detail="no_pending_draw_offer")
    m = onevsone_room.get_match(match_id)
    if m is not None:
        await _onevsone_broadcast(m, {
            "type": "draw_accepted",
            "by": payload.client_id,
            "winner": "draw",
            "finish_reason": "agreed_draw",
        })
    return result


@app.post("/api/onevsone/match/{match_id}/draw_decline")
async def onevsone_match_draw_decline(
    match_id: str, payload: OneVsOneActionRequest,
) -> dict[str, Any]:
    result = await onevsone_room.decline_draw(match_id, payload.client_id)
    if result is None:
        raise HTTPException(status_code=404, detail="no_pending_draw_offer")
    m = onevsone_room.get_match(match_id)
    if m is not None:
        await _onevsone_broadcast(m, {
            "type": "draw_declined",
            "by": payload.client_id,
        })
    return result


@app.post("/api/onevsone/match/{match_id}/resign")
async def onevsone_match_resign(
    match_id: str, payload: OneVsOneActionRequest,
) -> dict[str, Any]:
    result = await onevsone_room.resign(match_id, payload.client_id)
    if result is None:
        raise HTTPException(status_code=404, detail="match_not_found_or_finished")
    # Notify both peers via in-game WS broadcast (handled inside ws loop).
    m = onevsone_room.get_match(match_id)
    if m is not None:
        await _onevsone_broadcast(m, {
            "type": "resigned",
            "by": payload.client_id,
            "winner": result.get("winner"),
            "finish_reason": "resign",
        })
    return result


def _onevsone_build_pgn(m: onevsone_room.Match) -> str:
    """Render the match as a standards-compliant PGN.

    Uses python-chess's PGN writer so SAN notation, result tags and
    headers come out in the same shape chess.com / lichess produce —
    important because the user may want to paste this into Analysis
    view, or feed it into a third-party tool that imports PGN.
    """
    import chess.pgn  # local import: pgn module is rarely used and ~200KB

    pgn = chess.pgn.Game()
    pgn.headers["Event"] = "Chess Sandbox 1v1"
    pgn.headers["Site"] = "chess-sandbox"
    pgn.headers["Date"] = time.strftime("%Y.%m.%d", time.gmtime(m.created_at))
    pgn.headers["Round"] = "-"
    pgn.headers["White"] = m.white.nickname or "White"
    pgn.headers["Black"] = m.black.nickname or "Black"
    tc = f"{m.time_seconds}"
    if m.increment_seconds:
        tc += f"+{m.increment_seconds}"
    pgn.headers["TimeControl"] = tc
    if m.finished:
        if m.winner == "w":
            pgn.headers["Result"] = "1-0"
        elif m.winner == "b":
            pgn.headers["Result"] = "0-1"
        elif m.winner == "draw":
            pgn.headers["Result"] = "1/2-1/2"
        else:
            pgn.headers["Result"] = "*"
        if m.finish_reason:
            pgn.headers["Termination"] = m.finish_reason
    else:
        pgn.headers["Result"] = "*"
    # Reconstruct the game from the move list (FEN-after-each-move isn't
    # enough for python-chess; it wants Moves on a Board so it can emit
    # SAN with full check / mate annotations).
    board = chess.Board()
    node: chess.pgn.GameNode = pgn
    for entry in m.move_history:
        uci = str(entry.get("uci") or "")
        if not uci:
            continue
        try:
            move = chess.Move.from_uci(uci)
        except ValueError:
            continue
        if move not in board.legal_moves:
            # Defensive — if the persisted history is somehow out of
            # sync with the board state, stop rather than emit garbage.
            break
        node = node.add_variation(move)
        board.push(move)
    return str(pgn)


@app.get("/api/onevsone/match/{match_id}/pgn")
async def onevsone_match_pgn(
    match_id: str,
    client_id: str = Query(..., min_length=4, max_length=64),
    download: int = Query(default=1, ge=0, le=1),
) -> Response:
    """Return the match transcript as PGN.

    Only the two players can pull this — match IDs are unguessable but
    a player nickname could leak via a careless URL share, so we still
    require the caller's ``client_id`` to be one of the seats.
    ``?download=1`` (default) sets a Content-Disposition so the browser
    saves the file; ``?download=0`` returns it inline so the Analysis
    view can fetch it for the engine review pipeline."""
    m = onevsone_room.get_match(match_id)
    if m is None:
        raise HTTPException(status_code=404, detail="match_not_found")
    if m.player_for(client_id) is None:
        raise HTTPException(status_code=403, detail="not_a_player")
    try:
        pgn_text = _onevsone_build_pgn(m)
    except Exception:
        logger.exception("onevsone: PGN build failed for match %s", match_id)
        raise HTTPException(status_code=500, detail="pgn_build_failed") from None
    headers: dict[str, str] = {}
    if download:
        # Build the filename in two layers so Cyrillic / emoji nicknames
        # don't blow up Starlette's latin-1 header encoder (the previous
        # version raised UnicodeEncodeError → 500 the moment somebody
        # with a non-ASCII nick clicked "Скачать PGN").
        #
        # - ``filename=`` is the legacy fallback. It MUST be latin-1
        #   safe, so we keep ASCII letters/digits/-/_ only and replace
        #   everything else with a placeholder.
        # - ``filename*=UTF-8''…`` is the RFC 5987 form. Browsers
        #   that understand it (every modern one) show the original
        #   Cyrillic name; older clients fall back to the ASCII one.
        from urllib.parse import quote
        def _ascii_slug(s: str) -> str:
            keep = [c for c in s if c.isascii() and (c.isalnum() or c in ("-", "_"))]
            return ("".join(keep) or "anon")[:24]
        def _unicode_slug(s: str) -> str:
            keep = [c for c in s if c.isalnum() or c in ("-", "_")]
            return ("".join(keep) or "anon")[:24]
        ascii_name = (
            f"sandbox_{_ascii_slug(m.white.nickname)}"
            f"_vs_{_ascii_slug(m.black.nickname)}_{match_id}.pgn"
        )
        utf8_name = (
            f"sandbox_{_unicode_slug(m.white.nickname)}"
            f"_vs_{_unicode_slug(m.black.nickname)}_{match_id}.pgn"
        )
        headers["Content-Disposition"] = (
            f'attachment; filename="{ascii_name}"; '
            f"filename*=UTF-8''{quote(utf8_name)}"
        )
    return Response(
        content=pgn_text,
        media_type="application/x-chess-pgn; charset=utf-8",
        headers=headers,
    )


@app.get("/api/onevsone/online")
async def onevsone_online_users(
    client_id: str = Query(..., min_length=4, max_length=64),
) -> dict[str, Any]:
    """List of all visitors with online/offline status. ``client_id``
    is the caller, used to mark themselves so the frontend can grey
    them out / hide them from the challenge list."""
    rows = users_db.list_users()
    return {"me": client_id, "users": rows}


async def _onevsone_broadcast(match: onevsone_room.Match, payload: dict[str, Any]) -> None:
    """Fan-out a payload to both peers' live WebSockets, ignoring closed sockets."""
    for cid, sock in list(match.sockets.items()):
        if sock is None:
            continue
        try:
            await sock.send_json(payload)
        except Exception:
            # Socket likely closed mid-send; drop the registration.
            match.sockets.pop(cid, None)


@app.websocket("/api/onevsone/ws")
async def onevsone_ws(ws: WebSocket) -> None:
    """Live match relay. Each peer connects with ``match_id`` +
    ``client_id`` query params. Server validates moves, updates clocks
    and broadcasts ``move`` / ``resigned`` / ``ended`` payloads to the
    opposite peer."""
    match_id = ws.query_params.get("match_id") or ""
    client_id = ws.query_params.get("client_id") or ""
    if not match_id or not client_id:
        await ws.close(code=4400)
        return
    match = await onevsone_room.attach_socket(match_id, client_id, ws)
    if match is None:
        await ws.close(code=4404)
        return
    await ws.accept()
    try:
        await ws.send_json({"type": "state", "match": match.public(client_id)})
    except Exception:
        await onevsone_room.detach_socket(match_id, client_id)
        return
    try:
        while True:
            msg = await ws.receive_json()
            if not isinstance(msg, dict):
                continue
            mtype = msg.get("type")
            if mtype == "move":
                uci = str(msg.get("uci") or "")
                result = await onevsone_room.apply_move(match_id, client_id, uci)
                if result is None:
                    await ws.send_json({"type": "error", "code": "match_gone"})
                    continue
                if result.get("error"):
                    await ws.send_json({"type": "error", "code": result["error"]})
                    continue
                m_now = onevsone_room.get_match(match_id)
                if m_now is not None:
                    await _onevsone_broadcast(m_now, {"type": "move", **result})
            elif mtype == "resign":
                result = await onevsone_room.resign(match_id, client_id)
                if result is not None:
                    m_now = onevsone_room.get_match(match_id)
                    if m_now is not None:
                        await _onevsone_broadcast(m_now, {
                            "type": "resigned",
                            "by": client_id,
                            "winner": result.get("winner"),
                            "finish_reason": "resign",
                        })
            elif mtype == "draw_offer":
                result = await onevsone_room.offer_draw(match_id, client_id)
                if result is not None and not result.get("already"):
                    m_now = onevsone_room.get_match(match_id)
                    if m_now is not None:
                        await _onevsone_broadcast(m_now, {
                            "type": "draw_offer",
                            "by": client_id,
                        })
            elif mtype == "draw_accept":
                result = await onevsone_room.accept_draw(match_id, client_id)
                if result is not None:
                    m_now = onevsone_room.get_match(match_id)
                    if m_now is not None:
                        await _onevsone_broadcast(m_now, {
                            "type": "draw_accepted",
                            "by": client_id,
                            "winner": "draw",
                            "finish_reason": "agreed_draw",
                        })
            elif mtype == "draw_decline":
                result = await onevsone_room.decline_draw(match_id, client_id)
                if result is not None:
                    m_now = onevsone_room.get_match(match_id)
                    if m_now is not None:
                        await _onevsone_broadcast(m_now, {
                            "type": "draw_declined",
                            "by": client_id,
                        })
            elif mtype == "ping":
                await ws.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        logger.warning("onevsone ws error: %s", exc)
    finally:
        await onevsone_room.detach_socket(match_id, client_id)


# ---- Static avatars ----
#
# Mount the on-disk avatars directory at ``/api/avatars``. Done before
# the SPA fallback so requests like ``/api/avatars/<cid>.png`` aren't
# captured by the catch-all ``/{path:path}`` handler at the bottom.

_AVATAR_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/api/avatars", StaticFiles(directory=_AVATAR_DIR), name="avatars")


# ---- Static frontend ----

frontend_dir = settings.frontend_dir


def _index_html_with_cache_busters(frontend_root: Path) -> str:
    """Return ``index.html`` with ``?v=<mtime>`` appended to ``app.js`` and
    ``style.css`` references so that newly deployed JS/CSS isn't served from
    the browser HTTP cache after a code update. Without this, users who
    leave the tab open across deploys keep running the previous bundle and
    miss bug fixes (e.g. the 1 vs 1 UCI suffix fix that resulted in
    "piece teleports back" reports until the user did a hard reload)."""
    html = (frontend_root / "index.html").read_text(encoding="utf-8")
    for asset in ("app.js", "style.css"):
        path = frontend_root / asset
        if not path.exists():
            continue
        try:
            version = str(int(path.stat().st_mtime))
        except OSError:
            continue
        html = html.replace(f'/static/{asset}"', f'/static/{asset}?v={version}"')
    return html


if frontend_dir.exists():
    # Mount all static assets, but keep `/` returning index.html so navigation works.
    app.mount("/static", StaticFiles(directory=frontend_dir), name="static")

    @app.get("/")
    async def root() -> HTMLResponse:
        return HTMLResponse(_index_html_with_cache_busters(frontend_dir))

    _frontend_root = frontend_dir.resolve()

    @app.get("/{path:path}", response_model=None)
    async def serve_frontend(path: str) -> FileResponse | HTMLResponse:
        candidate = (frontend_dir / path).resolve()
        if candidate.is_file() and candidate.is_relative_to(_frontend_root):
            return FileResponse(candidate)
        # SPA fallback: serve index.html for any non-asset path.
        return HTMLResponse(_index_html_with_cache_busters(frontend_dir))

else:

    @app.get("/")
    async def root_missing_frontend() -> JSONResponse:
        return JSONResponse(
            {"detail": f"Frontend directory not found at {frontend_dir}"},
            status_code=500,
        )
