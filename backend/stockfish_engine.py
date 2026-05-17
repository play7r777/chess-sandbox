"""Thin async wrapper around python-chess UCI engine for Stockfish.

Public surface
--------------
The module exposes a single ``engine`` object whose API matches what
the rest of the backend used to call on a single-worker
``StockfishEngine`` — ``configure()``, ``best_move()``, ``analyse()``,
``analyse_raw()``, ``stop()`` plus the ``is_running`` / ``path``
properties. Callers don't need to change.

Internals
---------
Under the hood ``engine`` is now an :class:`EnginePool` that fans
requests out across N long-lived ``_Worker`` processes (one Stockfish
binary each). A bounded :class:`asyncio.Queue` holds idle workers;
:meth:`EnginePool._acquire` pulls the next free one, the request runs
on it, and :meth:`EnginePool._release` puts it back. Two concurrent
``/api/engine/analyse`` calls now run in parallel on different
processes instead of serialising on a shared lock.

Pool size defaults to ``settings.stockfish_pool_size`` (2) but is
clamped to ``[1, 16]`` in :meth:`EnginePool.configure` so a stray env
var can't blow up RAM with 64 hash tables.

Stateless guarantees
--------------------
Each call sends the FEN through ``board = chess.Board(fen)`` and uses
``engine.play(board, …)`` / ``engine.analyse(board, …)``, so a worker
that just finished a different request can't bleed positional state
into the next one (python-chess sends ``ucinewgame`` + ``position fen``
on every call). MultiPV is set per-request via the ``multipv`` kwarg to
``analyse()``; we never call ``configure({"MultiPV": …})`` because
python-chess refuses (auto-managed).
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


class _Worker:
    """Single Stockfish process + a per-process asyncio lock.

    ``SimpleEngine`` muxes through one stdin/stdout pipe and can't service
    two parallel ``analyse()`` calls. The pool only hands out a worker
    that isn't currently being held by anyone else, so the lock is
    mostly a belt-and-suspenders guard against a buggy caller forgetting
    to release a worker.
    """

    def __init__(self, worker_id: int) -> None:
        self.worker_id = worker_id
        self.engine: chess.engine.SimpleEngine | None = None
        self.lock = asyncio.Lock()

    def is_running(self) -> bool:
        return self.engine is not None

    def start(self, path: str, options: EngineOptions) -> None:
        eng = chess.engine.SimpleEngine.popen_uci(path)
        try:
            opts: dict[str, int | str] = {}
            if "Threads" in eng.options:
                opts["Threads"] = options.threads
            if "Hash" in eng.options:
                opts["Hash"] = options.hash_mb
            if "Skill Level" in eng.options:
                opts["Skill Level"] = max(0, min(20, options.skill_level))
            if opts:
                eng.configure(opts)
        except Exception:
            eng.close()
            raise
        self.engine = eng

    def stop(self) -> None:
        eng = self.engine
        self.engine = None
        if eng is not None:
            try:
                eng.close()
            except Exception:
                logger.exception("worker %d: close() failed", self.worker_id)


class EnginePool:
    """Pool of Stockfish workers fronting a single public API.

    Each method (configure / best_move / analyse / analyse_raw / stop)
    is async and acquires a free worker from the internal queue. The
    pool size is fixed at ``configure()`` time. Re-configuring (e.g.
    user points at a different binary or bumps Hash) tears all workers
    down and starts a fresh set with the new options.
    """

    def __init__(self) -> None:
        self._workers: list[_Worker] = []
        self._idle: asyncio.Queue[_Worker] = asyncio.Queue()
        self._configure_lock = asyncio.Lock()
        self._path: str | None = None
        self._options: EngineOptions = EngineOptions()
        self._pool_size: int = 1

    @property
    def path(self) -> str | None:
        return self._path

    @property
    def is_running(self) -> bool:
        return any(w.is_running() for w in self._workers)

    @property
    def pool_size(self) -> int:
        return self._pool_size

    async def configure(
        self,
        path: str,
        options: EngineOptions | None = None,
        pool_size: int | None = None,
    ) -> dict[str, Any]:
        """(Re)build the pool with the given binary and options."""
        from .settings import settings
        if pool_size is None:
            pool_size = settings.stockfish_pool_size
        pool_size = max(1, min(int(pool_size or 1), 16))
        async with self._configure_lock:
            await self._stop_all_locked()
            self._path = path
            if options is not None:
                self._options = options
            self._pool_size = pool_size
            self._idle = asyncio.Queue()
            self._workers = []
            for i in range(pool_size):
                w = _Worker(worker_id=i)
                await asyncio.to_thread(w.start, path, self._options)
                self._workers.append(w)
                self._idle.put_nowait(w)
            probe = self._workers[0].engine
            engine_id = dict(probe.id) if probe is not None else {}
            return {
                "path": path,
                "id": engine_id,
                "pool_size": pool_size,
                "options": {
                    "threads": self._options.threads,
                    "hash_mb": self._options.hash_mb,
                    "skill_level": self._options.skill_level,
                    "multi_pv": self._options.multi_pv,
                },
            }

    async def _stop_all_locked(self) -> None:
        workers, self._workers = self._workers, []
        self._idle = asyncio.Queue()
        for w in workers:
            await asyncio.to_thread(w.stop)

    async def stop(self) -> None:
        async with self._configure_lock:
            await self._stop_all_locked()
            self._path = None

    async def _acquire(self) -> _Worker:
        if not self._workers:
            raise RuntimeError("Engine is not configured. Call configure() first.")
        return await self._idle.get()

    def _release(self, w: _Worker) -> None:
        # Only release workers that are still in the active set — a
        # reconfigure between acquire and release will have orphaned w.
        if w in self._workers:
            self._idle.put_nowait(w)

    async def best_move(
        self,
        fen: str,
        movetime_ms: int | None = None,
        depth: int | None = None,
    ) -> AnalysisResult:
        w = await self._acquire()
        try:
            sf = w.engine
            if sf is None:
                raise RuntimeError("Engine worker is not running.")
            board = chess.Board(fen)
            limit = chess.engine.Limit(
                time=(movetime_ms / 1000) if movetime_ms else None,
                depth=depth,
            )
            async with w.lock:
                result, info = await asyncio.to_thread(_do_play, sf, board, limit)
        finally:
            self._release(w)

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

    async def analyse_raw(
        self,
        fen: str,
        movetime_ms: int | None = None,
        depth: int | None = None,
        multipv: int = 1,
    ) -> list[dict[str, Any]]:
        w = await self._acquire()
        try:
            sf = w.engine
            if sf is None:
                raise RuntimeError("Engine worker is not running.")
            board = chess.Board(fen)
            limit = chess.engine.Limit(
                time=(movetime_ms / 1000) if movetime_ms else None,
                depth=depth,
            )
            async with w.lock:
                infos = await asyncio.to_thread(_do_analyse, sf, board, limit, multipv)
        finally:
            self._release(w)
        return infos

    async def analyse(
        self,
        fen: str,
        movetime_ms: int | None = None,
        depth: int | None = None,
        multipv: int = 1,
    ) -> list[AnalysisResult]:
        w = await self._acquire()
        try:
            sf = w.engine
            if sf is None:
                raise RuntimeError("Engine worker is not running.")
            board = chess.Board(fen)
            limit = chess.engine.Limit(
                time=(movetime_ms / 1000) if movetime_ms else None,
                depth=depth,
            )
            async with w.lock:
                infos = await asyncio.to_thread(_do_analyse, sf, board, limit, multipv)
        finally:
            self._release(w)

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


def _do_play(
    sf: chess.engine.SimpleEngine,
    board: chess.Board,
    limit: chess.engine.Limit,
) -> tuple[chess.engine.PlayResult, dict[str, Any]]:
    result = sf.play(board, limit, info=chess.engine.INFO_ALL)
    return result, dict(result.info or {})


def _do_analyse(
    sf: chess.engine.SimpleEngine,
    board: chess.Board,
    limit: chess.engine.Limit,
    multipv: int,
) -> list[dict[str, Any]]:
    infos = sf.analyse(board, limit, multipv=multipv)
    if isinstance(infos, dict):
        infos = [infos]
    return [dict(i) for i in infos]


# Public singleton used throughout the backend. Despite the name it's
# really a pool — see EnginePool docstring.
engine = EnginePool()


# Backwards-compat: a couple of modules (and tests) imported the old
# ``StockfishEngine`` class symbol. Re-export ``EnginePool`` under that
# name so external callers don't break.
StockfishEngine = EnginePool
