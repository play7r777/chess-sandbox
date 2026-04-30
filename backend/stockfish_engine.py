"""Thin wrapper around python-chess UCI engine for Stockfish.

The engine process is started lazily and kept alive between requests. If the
binary path or options change at runtime we restart the process transparently.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import Any

import chess
import chess.engine

logger = logging.getLogger(__name__)


@dataclass
class EngineOptions:
    threads: int = 2
    hash_mb: int = 256
    skill_level: int = 20  # 0..20
    multi_pv: int = 1


@dataclass
class AnalysisResult:
    best_move_uci: str | None
    ponder_uci: str | None
    score_cp: int | None
    score_mate: int | None
    depth: int | None
    pv: list[str]


class StockfishEngine:
    """Async-friendly singleton-style wrapper around `chess.engine.SimpleEngine`.

    `python-chess` exposes both a sync `SimpleEngine` and an async transport.
    We use the sync API but call it from a worker thread so FastAPI handlers
    never block the event loop.
    """

    def __init__(self) -> None:
        self._engine: chess.engine.SimpleEngine | None = None
        self._path: str | None = None
        self._options: EngineOptions = EngineOptions()
        self._lock = asyncio.Lock()

    @property
    def path(self) -> str | None:
        return self._path

    @property
    def is_running(self) -> bool:
        return self._engine is not None

    async def configure(
        self,
        path: str,
        options: EngineOptions | None = None,
    ) -> dict[str, Any]:
        """Start (or restart) the engine with the given binary and options."""
        async with self._lock:
            await self._stop_locked()
            self._path = path
            if options is not None:
                self._options = options
            await asyncio.to_thread(self._start_locked)
            assert self._engine is not None
            info: dict[str, Any] = {
                "path": path,
                "id": dict(self._engine.id),
                "options": {
                    "threads": self._options.threads,
                    "hash_mb": self._options.hash_mb,
                    "skill_level": self._options.skill_level,
                    "multi_pv": self._options.multi_pv,
                },
            }
            return info

    def _start_locked(self) -> None:
        assert self._path is not None
        engine = chess.engine.SimpleEngine.popen_uci(self._path)
        try:
            opts: dict[str, int | str] = {}
            if "Threads" in engine.options:
                opts["Threads"] = self._options.threads
            if "Hash" in engine.options:
                opts["Hash"] = self._options.hash_mb
            if "Skill Level" in engine.options:
                opts["Skill Level"] = max(0, min(20, self._options.skill_level))
            # NB: MultiPV is managed automatically by python-chess during
            # `analyse()`; trying to set it here raises "cannot set MultiPV
            # which is automatically managed".
            if opts:
                engine.configure(opts)
        except Exception:
            engine.close()
            raise
        self._engine = engine

    async def _stop_locked(self) -> None:
        engine = self._engine
        self._engine = None
        if engine is not None:
            await asyncio.to_thread(engine.close)

    async def stop(self) -> None:
        async with self._lock:
            await self._stop_locked()

    async def best_move(
        self,
        fen: str,
        movetime_ms: int | None = None,
        depth: int | None = None,
    ) -> AnalysisResult:
        """Ask the engine for a move from the given FEN position."""
        async with self._lock:
            if self._engine is None:
                raise RuntimeError("Engine is not configured. Call configure() first.")
            board = chess.Board(fen)
            limit = chess.engine.Limit(
                time=(movetime_ms / 1000) if movetime_ms else None,
                depth=depth,
            )
            engine = self._engine

            def _play() -> tuple[chess.engine.PlayResult, dict[str, Any]]:
                result = engine.play(board, limit, info=chess.engine.INFO_ALL)
                # play() returns a PlayResult; info is on result.info
                return result, dict(result.info or {})

            result, info = await asyncio.to_thread(_play)

        score = info.get("score")
        score_cp: int | None = None
        score_mate: int | None = None
        if score is not None:
            pov = score.white() if board.turn == chess.WHITE else score.black()
            if pov.is_mate():
                score_mate = pov.mate()
            else:
                score_cp = pov.score()
        pv_moves: list[chess.Move] = info.get("pv", []) or []
        return AnalysisResult(
            best_move_uci=result.move.uci() if result.move else None,
            ponder_uci=result.ponder.uci() if result.ponder else None,
            score_cp=score_cp,
            score_mate=score_mate,
            depth=info.get("depth"),
            pv=[m.uci() for m in pv_moves],
        )

    async def analyse(
        self,
        fen: str,
        movetime_ms: int | None = None,
        depth: int | None = None,
        multipv: int = 1,
    ) -> list[AnalysisResult]:
        """Run a static evaluation and return the top `multipv` lines."""
        async with self._lock:
            if self._engine is None:
                raise RuntimeError("Engine is not configured. Call configure() first.")
            board = chess.Board(fen)
            limit = chess.engine.Limit(
                time=(movetime_ms / 1000) if movetime_ms else None,
                depth=depth,
            )
            engine = self._engine

            def _analyse() -> list[dict[str, Any]]:
                infos = engine.analyse(board, limit, multipv=multipv)
                if isinstance(infos, dict):
                    infos = [infos]
                return [dict(i) for i in infos]

            infos = await asyncio.to_thread(_analyse)

        results: list[AnalysisResult] = []
        for info in infos:
            score = info.get("score")
            score_cp: int | None = None
            score_mate: int | None = None
            if score is not None:
                pov = score.white() if board.turn == chess.WHITE else score.black()
                if pov.is_mate():
                    score_mate = pov.mate()
                else:
                    score_cp = pov.score()
            pv_moves: list[chess.Move] = info.get("pv", []) or []
            best = pv_moves[0].uci() if pv_moves else None
            results.append(
                AnalysisResult(
                    best_move_uci=best,
                    ponder_uci=None,
                    score_cp=score_cp,
                    score_mate=score_mate,
                    depth=info.get("depth"),
                    pv=[m.uci() for m in pv_moves],
                )
            )
        return results


engine = StockfishEngine()
