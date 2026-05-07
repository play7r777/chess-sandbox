"""Tiny async client for a local Ollama daemon.

Used by the Opening Trainer AI coach to turn a (FEN, last move,
Stockfish evaluation, opening theory snippet) tuple into a chatty
Russian-language explanation streamed to the browser.

The client is intentionally minimal — we only need /api/chat with
streaming enabled. Failures (Ollama not running, model missing,
network blip, httpx not installed) raise `OllamaUnavailable` so
callers can fall back to canned coach feedback.
"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

# httpx is a hard dep in pyproject.toml, but we import defensively so an
# older venv that hasn't run `pip install -e .` since httpx was promoted
# from [dev] to main dependencies still boots — the AI-coach paths just
# fall back to canned feedback in that case.
try:
    import httpx
    _HTTPX_AVAILABLE = True
except ImportError:  # pragma: no cover — defensive import
    httpx = None  # type: ignore[assignment]
    _HTTPX_AVAILABLE = False

logger = logging.getLogger(__name__)


class OllamaUnavailable(RuntimeError):
    """Raised when the local Ollama daemon cannot be reached."""


@dataclass(frozen=True)
class OllamaConfig:
    base_url: str
    model: str
    timeout_s: float = 60.0
    num_predict: int = 320


def _normalize_base_url(url: str) -> str:
    return url.rstrip("/") if url else ""


async def is_alive(config: OllamaConfig) -> bool:
    """Return True if the Ollama daemon answers the /api/tags probe."""
    if not _HTTPX_AVAILABLE:
        return False
    base = _normalize_base_url(config.base_url)
    if not base:
        return False
    try:
        async with httpx.AsyncClient(timeout=2.0) as client:
            resp = await client.get(f"{base}/api/tags")
            return resp.status_code == 200
    except Exception:
        return False


async def list_models(config: OllamaConfig) -> list[str]:
    """Return locally installed model names (best-effort)."""
    if not _HTTPX_AVAILABLE:
        return []
    base = _normalize_base_url(config.base_url)
    if not base:
        return []
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{base}/api/tags")
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        return []
    out: list[str] = []
    for item in data.get("models") or []:
        name = item.get("name") or item.get("model")
        if isinstance(name, str):
            out.append(name)
    return out


async def stream_chat(
    config: OllamaConfig,
    messages: list[dict[str, str]],
    *,
    extra_options: dict[str, Any] | None = None,
) -> AsyncIterator[str]:
    """Stream the assistant text deltas from Ollama's /api/chat.

    Yields plain-text chunks (already decoded from the JSONL frames).
    Raises `OllamaUnavailable` if the daemon refuses the connection or
    returns a non-200 response.
    """
    base = _normalize_base_url(config.base_url)
    if not base:
        raise OllamaUnavailable("CHESS_OLLAMA_BASE_URL is empty")

    payload: dict[str, Any] = {
        "model": config.model,
        "messages": messages,
        "stream": True,
        "options": {
            "num_predict": int(config.num_predict),
            "temperature": 0.4,
        },
    }
    if extra_options:
        opts = dict(payload["options"])
        opts.update(extra_options)
        payload["options"] = opts

    url = f"{base}/api/chat"
    try:
        async with httpx.AsyncClient(timeout=config.timeout_s) as client:
            async with client.stream("POST", url, json=payload) as resp:
                if resp.status_code >= 400:
                    body = await resp.aread()
                    raise OllamaUnavailable(
                        f"Ollama HTTP {resp.status_code}: {body[:200]!r}"
                    )
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        frame = json.loads(line)
                    except json.JSONDecodeError:
                        logger.debug("Ollama: bad JSON line %r", line[:200])
                        continue
                    msg = frame.get("message")
                    if isinstance(msg, dict):
                        chunk = msg.get("content")
                        if isinstance(chunk, str) and chunk:
                            yield chunk
                    if frame.get("done"):
                        return
    except OllamaUnavailable:
        raise
    except (httpx.HTTPError, OSError) as exc:
        raise OllamaUnavailable(f"Ollama unreachable: {exc}") from exc


async def chat_collect(
    config: OllamaConfig,
    messages: list[dict[str, str]],
    *,
    extra_options: dict[str, Any] | None = None,
) -> str:
    """Convenience: collect a non-streaming chat reply into a single string."""
    chunks: list[str] = []
    async for chunk in stream_chat(config, messages, extra_options=extra_options):
        chunks.append(chunk)
    return "".join(chunks)
