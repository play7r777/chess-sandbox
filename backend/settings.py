"""Runtime configuration for the chess sandbox backend."""
from __future__ import annotations

import shutil
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Read configuration from environment variables and an optional `.env` file."""

    model_config = SettingsConfigDict(env_file=".env", env_prefix="CHESS_", extra="ignore")

    stockfish_path: str = ""
    stockfish_threads: int = 2
    stockfish_hash_mb: int = 256
    stockfish_default_movetime_ms: int = 1000
    stockfish_default_skill_level: int = 20

    # Ollama (local LLM) integration for the Opening Trainer AI coach.
    # Set CHESS_OLLAMA_BASE_URL / CHESS_OLLAMA_MODEL in the env or .env to
    # point at a running Ollama daemon. Empty string disables AI coach
    # gracefully — endpoints fall back to canned coach feedback.
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "llama3.2:3b"
    ollama_timeout_s: float = 60.0
    ollama_num_predict: int = 320

    host: str = "127.0.0.1"
    port: int = 8000

    frontend_dir: Path = Path(__file__).resolve().parent.parent / "frontend"
    backend_root: Path = Path(__file__).resolve().parent

    # Where mutable state lives (users / leaderboard / party history /
    # puzzle SQLite). Sits next to the bundled puzzle pack so the app
    # is fully self-contained for a local install.
    data_dir: Path = Path(__file__).resolve().parent / "data"

    def resolve_stockfish_path(self) -> str | None:
        """Return the Stockfish binary path, falling back to PATH lookup."""
        if self.stockfish_path:
            candidate = Path(self.stockfish_path).expanduser()
            if candidate.exists():
                return str(candidate)
            on_path = shutil.which(self.stockfish_path)
            if on_path:
                return on_path
            return None
        for name in ("stockfish", "stockfish.exe"):
            on_path = shutil.which(name)
            if on_path:
                return on_path
        for default in DEFAULT_WINDOWS_STOCKFISH_PATHS + DEFAULT_UNIX_STOCKFISH_PATHS:
            candidate = Path(default).expanduser()
            if candidate.exists():
                return str(candidate)
        return None


DEFAULT_WINDOWS_STOCKFISH_PATHS: list[str] = [
    r"C:\stockfish\stockfish-windows-x86-64-avx2.exe",
    r"C:\stockfish\stockfish.exe",
    r"C:\Program Files\Stockfish\stockfish.exe",
    r"C:\Program Files\Stockfish\stockfish-windows-x86-64-avx2.exe",
]

DEFAULT_UNIX_STOCKFISH_PATHS: list[str] = [
    "/usr/games/stockfish",
    "/usr/local/bin/stockfish",
    "/opt/homebrew/bin/stockfish",
]


settings = Settings()
