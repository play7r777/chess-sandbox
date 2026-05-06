"""FastAPI application exposing the sandbox UI and the engine/recognition APIs."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Any

import chess
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import puzzles as puzzles_db
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


@asynccontextmanager
async def lifespan(app: FastAPI):
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

@app.get("/api/puzzle/stats")
async def puzzle_stats() -> dict[str, Any]:
    """Pack-level metadata: counts, difficulty bands, theme labels."""
    return puzzles_db.stats()


@app.get("/api/puzzle/random")
async def puzzle_random(
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
async def puzzle_by_id(puzzle_id: str) -> dict[str, Any]:
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
