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
