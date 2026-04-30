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

    host: str = "127.0.0.1"
    port: int = 8000

    frontend_dir: Path = Path(__file__).resolve().parent.parent / "frontend"

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
        return None


settings = Settings()
