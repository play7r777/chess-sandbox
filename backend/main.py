"""FastAPI application exposing the sandbox UI and the engine/recognition APIs."""
from __future__ import annotations

import asyncio
import json
import logging
from contextlib import asynccontextmanager
from typing import Any

import chess
from fastapi import FastAPI, File, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import daily_puzzle as daily_puzzle_pack
from . import notifications as notifications_db
from . import ollama as ollama_client
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
    avatar: str = Field(default="♟", max_length=8)


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


class OpeningCoachRequest(BaseModel):
    opening_id: str = Field(..., min_length=1, max_length=64)
    ply: int = Field(..., ge=0, le=64, description="Ply position the user is asking about")
    last_san: str | None = Field(default=None, max_length=12, description="The user's actual last move in SAN, if any")
    correct: bool | None = Field(default=None, description="Whether the user's last move matched the trained line")
    locale: str = Field(default="ru", min_length=2, max_length=8)
    # Stockfish knobs (front-end picker on the AI panel). Defaults match
    # the previous hardcoded values so old clients keep working.
    depth: int = Field(default=18, ge=6, le=40)
    multipv: int = Field(default=2, ge=1, le=4)


class AnalysisCoachRequest(BaseModel):
    """Request payload for the AI coach in the Analysis (Game Review) view.

    The frontend already has every field below from a previous
    /api/game/analyse pass — we re-use that data to avoid burning
    Stockfish time on each coach click.
    """
    fen_before: str = Field(..., min_length=10, max_length=128)
    fen_after: str = Field(..., min_length=10, max_length=128)
    move_san: str = Field(..., min_length=1, max_length=12)
    best_move_san: str | None = Field(default=None, max_length=12)
    classification: str = Field(..., min_length=1, max_length=24)
    eval_before_cp: int = Field(..., ge=-200000, le=200000)
    eval_after_cp: int = Field(..., ge=-200000, le=200000)
    side: str = Field(..., min_length=1, max_length=1)
    ply: int = Field(..., ge=0, le=2048)
    best_pv_san: list[str] = Field(default_factory=list, max_length=16)
    played_pv_san: list[str] = Field(default_factory=list, max_length=16)
    coach_hints: list[str] = Field(default_factory=list, max_length=8)
    headers: dict[str, str] = Field(default_factory=dict)
    locale: str = Field(default="ru", min_length=2, max_length=8)


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


@asynccontextmanager
async def lifespan(app: FastAPI):
    _print_puzzle_banner()
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


@app.post("/api/engine/configure")
async def engine_configure(req: EngineConfigRequest) -> dict[str, Any]:
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
async def engine_stop() -> dict[str, Any]:
    await engine.stop()
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


@app.get("/api/opening_trainer/coach/status")
async def opening_trainer_coach_status() -> dict[str, Any]:
    """Probe local Ollama daemon — used by the UI to decide whether to
    show the AI coach button or fall back to canned coach lines."""
    cfg = ollama_client.OllamaConfig(
        base_url=settings.ollama_base_url,
        model=settings.ollama_model,
        timeout_s=settings.ollama_timeout_s,
        num_predict=settings.ollama_num_predict,
    )
    alive = await ollama_client.is_alive(cfg)
    models = await ollama_client.list_models(cfg) if alive else []
    return {
        "available": alive,
        "model": settings.ollama_model,
        "base_url": settings.ollama_base_url,
        "installed_models": models,
        "stockfish_running": engine.is_running,
    }


def _coach_eval_summary(
    score_cp: int | None,
    score_mate: int | None,
    pv_san: list[str],
) -> str:
    """Format Stockfish output for the LLM prompt in human-readable form."""
    if score_mate is not None:
        verdict = f"мат в {abs(score_mate)} (+мат у {'белых' if score_mate > 0 else 'чёрных'})"
    elif score_cp is not None:
        cp = score_cp
        if cp >= 200:
            verdict = f"перевес белых ≈ +{cp/100:.2f} пешки"
        elif cp >= 50:
            verdict = f"небольшой перевес белых ≈ +{cp/100:.2f}"
        elif cp >= -50:
            verdict = f"равенство ({cp/100:+.2f})"
        elif cp >= -200:
            verdict = f"небольшой перевес чёрных ≈ {cp/100:.2f}"
        else:
            verdict = f"перевес чёрных ≈ {cp/100:.2f} пешки"
    else:
        verdict = "оценка не получена"
    line = " ".join(pv_san[:8]) if pv_san else "(нет линии)"
    return f"оценка: {verdict}; главная линия: {line}"


async def _stockfish_top_lines(fen: str, multipv: int = 2, depth: int = 18) -> list[dict[str, Any]]:
    """Return up to ``multipv`` Stockfish lines as {score_cp, score_mate, pv_san}.

    Returns an empty list if the engine is not configured / fails.
    """
    if not engine.is_running:
        return []
    try:
        infos = await engine.analyse_raw(fen, depth=depth, multipv=multipv)
    except Exception as exc:
        logger.warning("Stockfish coach eval failed: %s", exc)
        return []
    out: list[dict[str, Any]] = []
    board = chess.Board(fen)
    for info in infos:
        score = info.get("score")
        score_cp: int | None = None
        score_mate: int | None = None
        if score is not None:
            try:
                pov = score.white()
            except Exception:
                pov = score
            if pov.is_mate():
                score_mate = pov.mate()
            else:
                score_cp = pov.score()
        pv_moves = info.get("pv") or []
        pv_san: list[str] = []
        b = board.copy()
        for mv in pv_moves[:10]:
            try:
                pv_san.append(b.san(mv))
                b.push(mv)
            except Exception:
                break
        out.append({
            "score_cp": score_cp,
            "score_mate": score_mate,
            "pv_san": pv_san,
        })
    return out


def _build_coach_prompt(
    *,
    opening: opening_trainer_pack.Opening,
    ply: int,
    last_san: str | None,
    correct: bool | None,
    fen: str,
    line_so_far: list[str],
    expected_san: str | None,
    sf_lines: list[dict[str, Any]],
) -> list[dict[str, str]]:
    """Build the chat messages for the AI coach.

    The output format is chess.com Game-Review style:
        ВЕРДИКТ: <одна короткая строка>
        <пустая строка>
        <2–4 коротких предложения>

    The frontend parses this and renders the verdict as a big bold
    headline, with the body underneath. We are very explicit with the
    LLM about chess terminology (фигуры vs клетки/поля) because models
    like to write nonsense like «фигура e4» otherwise.
    """
    side = "белыми" if opening.side == "white" else "чёрными"
    sf_text_lines: list[str] = []
    for i, ln in enumerate(sf_lines, start=1):
        sf_text_lines.append(
            f"  {i}) " + _coach_eval_summary(ln.get("score_cp"), ln.get("score_mate"), ln.get("pv_san") or [])
        )
    sf_block = "\n".join(sf_text_lines) if sf_text_lines else "  (Stockfish недоступен)"
    line_history = " ".join(line_so_far) if line_so_far else "(старт партии)"
    if last_san:
        if correct is True:
            outcome_line = f"Последний ход ученика: {last_san} — совпадает с главной теоретической линией."
        elif correct is False:
            outcome_line = (
                f"Последний ход ученика: {last_san}. "
                f"Главный ход теории здесь: {expected_san or '(линия завершена)'}."
            )
        else:
            outcome_line = f"Последний ход ученика: {last_san}."
    else:
        outcome_line = (
            f"Ход {ply // 2 + 1}. Сейчас очередь {side}. "
            f"Главный ход теории: {expected_san or '(линия пройдена)'}."
        )

    system = (
        "Ты — шахматный тренер. Отвечаешь коротко и по делу, как Game Review на chess.com. "
        "Никакой воды, никаких длинных объяснений.\n"
        "\n"
        "ФОРМАТ ОТВЕТА (СТРОГО):\n"
        "ВЕРДИКТ: <одна короткая строка — оценка хода или позиции>\n"
        "\n"
        "<2–4 коротких предложения с объяснением>\n"
        "\n"
        "Никакого markdown, никаких звёздочек, никаких bullet-points, никаких заголовков "
        "вроде «Объяснение:».\n"
        "\n"
        "ТЕРМИНОЛОГИЯ — ВАЖНО, НЕ ПУТАЙ:\n"
        "• ФИГУРЫ — это пешка, конь, слон, ладья, ферзь, король.\n"
        "• ПОЛЯ (клетки) — это e4, d5, f7 и т.п. (буква + цифра).\n"
        "• Правильно: «пешка на e4», «слон с c4 на f7», «конь занял поле d5», «поле e6 ослаблено».\n"
        "• НЕПРАВИЛЬНО: «фигура e4», «клетка слон», «слон на коня c6». Никогда так не пиши.\n"
        "• Описывая ход, пиши сначала фигуру, потом поле: «слон на b5», а не «b5 слон».\n"
        "• Если хочешь сослаться на ход в нотации — пиши SAN как есть: «Bb5», «Nxd4».\n"
        "\n"
        "ЧТО ПИСАТЬ В ВЕРДИКТЕ (одна короткая строка, 4–8 слов):\n"
        "• Если ход совпадает с главной теорией → «Точно по теории».\n"
        "• Если ход не теория, но Stockfish не теряет оценки (≤ 30 cp от лучшего) → «Хороший ход».\n"
        "• Если ход теряет 30–100 cp → «Не лучший ход. Лучше: <SAN>».\n"
        "• Если ход теряет больше 100 cp → «Грубая ошибка. Нужно было: <SAN>».\n"
        "• Если ход вообще не оценивается (старт линии) → «Готовимся к ходу <SAN>».\n"
        "\n"
        "ЧТО ПИСАТЬ В ОБЪЯСНЕНИИ:\n"
        "• Если ход правильный — одной фразой почему он хорош (план, идея дебюта).\n"
        "• Если ход плохой — одной фразой что не так и какой был план у правильного хода.\n"
        "• Опирайся ТОЛЬКО на теорию дебюта и оценку Stockfish, которые тебе дали. "
        "Не придумывай линии и не считай тактику дальше Stockfish.\n"
        "• Отвечай по-русски."
    )
    user = (
        f"Дебют: {opening.name} ({opening.eco}), играем {side}.\n"
        f"Теория дебюта: {opening.theory}\n"
        f"Сыгранная линия: {line_history}\n"
        f"{outcome_line}\n"
        f"FEN: {fen}\n"
        f"Stockfish (top {len(sf_lines) or 1}):\n{sf_block}\n"
        f"\n"
        f"Дай разбор строго в указанном формате: одна строка ВЕРДИКТ + 2–4 коротких "
        f"предложения объяснения. Помни про терминологию (фигуры vs поля)."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def _coach_fallback_text(
    opening: opening_trainer_pack.Opening,
    ply: int,
    expected_san: str | None,
    correct: bool | None,
    sf_lines: list[dict[str, Any]],
) -> str:
    bank = opening.coach_good if correct else opening.coach_bad
    base = bank[ply % len(bank)] if bank else opening.coach_complete or ""
    parts: list[str] = []
    if base:
        parts.append(base)
    parts.append(f"Главный ход теории: {expected_san or '(линия пройдена)'}.")
    if sf_lines:
        first = sf_lines[0]
        parts.append("Stockfish 18: " + _coach_eval_summary(
            first.get("score_cp"), first.get("score_mate"), first.get("pv_san") or [],
        ))
    parts.append(opening.theory)
    return "\n".join(parts)


@app.post("/api/opening_trainer/coach")
async def opening_trainer_coach(req: OpeningCoachRequest) -> StreamingResponse:
    """Stream AI-coach text for the given opening position.

    Combines Stockfish 18 evaluation + Ollama LLM. If Ollama is not
    available, falls back to canned coach lines + theory + Stockfish
    summary so the user always sees something useful.

    Response is `text/plain` with chunked transfer — frontend reads
    `response.body.getReader()` and appends each chunk to the panel.
    """
    opening = opening_trainer_pack.get_opening(req.opening_id)
    if opening is None:
        raise HTTPException(status_code=404, detail="Opening not found.")

    line = opening.line_san
    ply = req.ply
    if ply < 0:
        ply = 0
    if ply > len(line):
        ply = len(line)
    line_so_far = list(line[:ply])
    expected_san = line[ply] if ply < len(line) else None

    board = chess.Board()
    for san in line_so_far:
        try:
            board.push_san(san)
        except ValueError:
            break
    fen = board.fen()

    # Stockfish snapshot — best-effort, never blocks fallback path. Depth
    # and multipv come from the AI-panel picker so the user can dial in
    # the speed/quality trade-off (chess.com Game Review uses ~22).
    sf_lines = await _stockfish_top_lines(fen, multipv=req.multipv, depth=req.depth)

    cfg = ollama_client.OllamaConfig(
        base_url=settings.ollama_base_url,
        model=settings.ollama_model,
        timeout_s=settings.ollama_timeout_s,
        num_predict=settings.ollama_num_predict,
    )
    messages = _build_coach_prompt(
        opening=opening,
        ply=ply,
        last_san=req.last_san,
        correct=req.correct,
        fen=fen,
        line_so_far=line_so_far,
        expected_san=expected_san,
        sf_lines=sf_lines,
    )

    async def streamer() -> Any:
        # Try Ollama first; on any failure fall back to canned text so
        # the frontend always has something to display.
        try:
            async for chunk in ollama_client.stream_chat(cfg, messages):
                yield chunk.encode("utf-8")
            return
        except ollama_client.OllamaUnavailable as exc:
            logger.info("Ollama unavailable, falling back to canned coach: %s", exc)
        except Exception as exc:
            logger.warning("Ollama coach error: %s", exc)
        yield (
            "AI-тренер сейчас недоступен (запусти `ollama serve` локально). "
            "Вот разбор от встроенного тренера + Stockfish:\n\n"
        ).encode()
        text = _coach_fallback_text(opening, ply, expected_san, req.correct, sf_lines)
        yield text.encode()

    return StreamingResponse(streamer(), media_type="text/plain; charset=utf-8")


# ---- Analysis (Game Review) AI coach ----

ANALYSIS_CLASS_RU: dict[str, str] = {
    "brilliant": "Бриллиантовый ход",
    "great":     "Великолепный ход",
    "best":      "Лучший ход",
    "excellent": "Превосходный ход",
    "good":      "Хороший ход",
    "book":      "Теоретический ход",
    "forced":    "Вынужденный ход",
    "inaccuracy":"Неточность",
    "mistake":   "Ошибка",
    "blunder":   "Грубая ошибка",
    "miss":      "Упущенная победа",
}


def _analysis_eval_swing(eval_before_cp: int, eval_after_cp: int, side: str) -> str:
    """Describe the swing in centipawns from the mover's POV.

    The frontend ships eval-before/-after already from the mover's POV
    (see `MoveAnalysis.eval_before_cp` doc), so we can compare directly.
    """

    def _is_mate(cp: int) -> int | None:
        if cp >= 99000:
            return 100000 - cp
        if cp <= -99000:
            return -(cp + 100000)
        return None

    mate_before = _is_mate(eval_before_cp)
    mate_after = _is_mate(eval_after_cp)
    side_word = "белых" if side == "w" else "чёрных"
    if mate_before is not None or mate_after is not None:
        return (
            f"оценка с точки зрения {side_word} изменилась с "
            f"{('мат '+str(mate_before)) if mate_before is not None else f'{eval_before_cp/100:+.2f}'} на "
            f"{('мат '+str(mate_after)) if mate_after is not None else f'{eval_after_cp/100:+.2f}'}"
        )
    delta = eval_after_cp - eval_before_cp
    return (
        f"оценка с точки зрения {side_word}: до хода {eval_before_cp/100:+.2f}, "
        f"после хода {eval_after_cp/100:+.2f} (изменение {delta/100:+.2f})"
    )


def _build_analysis_coach_prompt(req: AnalysisCoachRequest) -> list[dict[str, str]]:
    """Build chat messages for the Game-Review AI coach. Russian, concise."""
    cls_label = ANALYSIS_CLASS_RU.get(req.classification, req.classification)
    move_no = req.ply // 2 + 1
    swing = _analysis_eval_swing(req.eval_before_cp, req.eval_after_cp, req.side)
    best_pv = " ".join(req.best_pv_san[:6]) if req.best_pv_san else "(нет линии)"
    played_pv = " ".join(req.played_pv_san[:6]) if req.played_pv_san else ""

    name_w = (req.headers.get("White") or "Белые").strip() if req.headers else "Белые"
    name_b = (req.headers.get("Black") or "Чёрные").strip() if req.headers else "Чёрные"
    elo_w = (req.headers.get("WhiteElo") or "").strip() if req.headers else ""
    elo_b = (req.headers.get("BlackElo") or "").strip() if req.headers else ""
    players = f"{name_w}{f' ({elo_w})' if elo_w else ''} vs {name_b}{f' ({elo_b})' if elo_b else ''}"

    system = (
        "Ты — опытный шахматный тренер уровня chess.com Game Review. "
        "Объясни ход на русском, коротко (4–7 предложений), но конкретно: "
        "(1) что именно стало хуже/лучше после хода, (2) какая идея стояла за лучшим ходом, "
        "(3) если был тактический мотив (вилка, связка, атака на короля и т.п.) — назови его. "
        "Опирайся на оценку Stockfish и линии, которые тебе дают; не выдумывай ходов. "
        "Не повторяй заголовок ('Это ошибка...') — пиши сразу по сути."
    )

    user_lines: list[str] = [
        f"Партия: {players}.",
        f"Ход {move_no} {'белых' if req.side == 'w' else 'чёрных'}: сыграно {req.move_san}.",
        f"Классификация Stockfish: {cls_label}.",
        f"Stockfish 18: {swing}.",
    ]
    if req.best_move_san and req.best_move_san != req.move_san:
        user_lines.append(f"Лучший ход по движку: {req.best_move_san}.")
        user_lines.append(f"Главная линия (после лучшего хода): {best_pv}.")
    else:
        user_lines.append(f"Главная линия от движка: {best_pv}.")
    if played_pv:
        user_lines.append(f"Что движок ожидал после {req.move_san}: {played_pv}.")
    if req.coach_hints:
        # Local heuristic hints (hanging piece, sacrifice etc.) — a useful
        # nudge to the LLM about *which motif* it should explain.
        user_lines.append("Подсказки локального тренера: " + "; ".join(req.coach_hints[:4]))
    user_lines.append(f"FEN до хода: {req.fen_before}")
    user_lines.append(
        "Объясни ученику простыми словами, почему ход получил такую оценку, "
        "и что было правильнее сыграть."
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": "\n".join(user_lines)},
    ]


def _analysis_coach_fallback_text(req: AnalysisCoachRequest) -> str:
    """Minimal canned explanation when Ollama is offline."""
    cls_label = ANALYSIS_CLASS_RU.get(req.classification, req.classification)
    parts: list[str] = [f"{cls_label}."]
    if req.best_move_san and req.best_move_san != req.move_san:
        parts.append(
            f"Сыграно {req.move_san}, лучше было {req.best_move_san}."
            + (f" Линия: {' '.join(req.best_pv_san[:6])}." if req.best_pv_san else "")
        )
    swing = _analysis_eval_swing(req.eval_before_cp, req.eval_after_cp, req.side)
    parts.append("Stockfish 18: " + swing + ".")
    if req.coach_hints:
        parts.append("Подсказки тренера: " + " · ".join(req.coach_hints[:3]) + ".")
    return " ".join(parts)


@app.post("/api/analysis/coach")
async def analysis_coach(req: AnalysisCoachRequest) -> StreamingResponse:
    """Stream AI-coach explanation for a single move in the Game Review.

    Re-uses the analysis data the client already has (eval, best move,
    PV, classification, canned hints) so we don't re-run Stockfish per
    click — a single coach request is just one Ollama round-trip.
    """
    cfg = ollama_client.OllamaConfig(
        base_url=settings.ollama_base_url,
        model=settings.ollama_model,
        timeout_s=settings.ollama_timeout_s,
        num_predict=settings.ollama_num_predict,
    )
    messages = _build_analysis_coach_prompt(req)

    async def streamer() -> Any:
        try:
            async for chunk in ollama_client.stream_chat(cfg, messages):
                yield chunk.encode("utf-8")
            return
        except ollama_client.OllamaUnavailable as exc:
            logger.info("Ollama unavailable, analysis fallback: %s", exc)
        except Exception as exc:
            logger.warning("Ollama analysis coach error: %s", exc)
        yield (
            "AI-тренер сейчас недоступен (запусти `ollama serve` локально). "
            "Краткий разбор от встроенного тренера:\n\n"
        ).encode()
        yield _analysis_coach_fallback_text(req).encode()

    return StreamingResponse(streamer(), media_type="text/plain; charset=utf-8")


@app.get("/api/analysis/coach/status")
async def analysis_coach_status() -> dict[str, Any]:
    """Same shape as /api/opening_trainer/coach/status — re-used by the
    Analysis tab so it can show an Ollama on/off badge independent of
    the Opening Trainer one (separate state in the UI)."""
    cfg = ollama_client.OllamaConfig(
        base_url=settings.ollama_base_url,
        model=settings.ollama_model,
        timeout_s=settings.ollama_timeout_s,
        num_predict=settings.ollama_num_predict,
    )
    alive = await ollama_client.is_alive(cfg)
    models = await ollama_client.list_models(cfg) if alive else []
    return {
        "available": alive,
        "model": settings.ollama_model,
        "base_url": settings.ollama_base_url,
        "installed_models": models,
        "stockfish_running": engine.is_running,
    }


# ---- Party / Co-op puzzles ----

class PartyCreateRequest(BaseModel):
    client_id: str = Field(..., min_length=4, max_length=64)
    nickname: str = Field(default="Гость", max_length=32)
    avatar: str = Field(default="♟", max_length=8)


@app.post("/api/party/create")
async def party_create(req: PartyCreateRequest) -> dict[str, Any]:
    party_room.reap_idle()
    p = await party_room.create_party(req.client_id, req.nickname, req.avatar)
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
                # The host can pick a 2/3/5/10-min match length in the
                # lobby; the value rides along on the start frame so we
                # don't need a separate REST hop. party.start() validates
                # against the allowlist, so passing through msg.get is safe.
                duration_sec = msg.get("duration_sec")
                try:
                    await party.start(client_id, duration_sec=duration_sec)
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
                # so watchers see the same board the player sees.
                await party.update_position(
                    client_id,
                    str(msg.get("fen") or ""),
                    flipped=bool(msg.get("flipped")) if "flipped" in msg else None,
                    last_move=str(msg.get("last_move") or "") if "last_move" in msg else None,
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


# ---- Static frontend ----

frontend_dir = settings.frontend_dir

if frontend_dir.exists():
    # Mount all static assets, but keep `/` returning index.html so navigation works.
    app.mount("/static", StaticFiles(directory=frontend_dir), name="static")

    @app.get("/")
    async def root() -> FileResponse:
        return FileResponse(frontend_dir / "index.html")

    _frontend_root = frontend_dir.resolve()

    @app.get("/{path:path}")
    async def serve_frontend(path: str) -> FileResponse:
        candidate = (frontend_dir / path).resolve()
        if candidate.is_file() and candidate.is_relative_to(_frontend_root):
            return FileResponse(candidate)
        # SPA fallback: serve index.html for any non-asset path.
        return FileResponse(frontend_dir / "index.html")

else:

    @app.get("/")
    async def root_missing_frontend() -> JSONResponse:
        return JSONResponse(
            {"detail": f"Frontend directory not found at {frontend_dir}"},
            status_code=500,
        )
