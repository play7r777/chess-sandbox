"""Runtime configuration for the chess sandbox backend."""
from __future__ import annotations

import ipaddress
import secrets
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
    # Number of Stockfish worker processes kept alive in the pool.
    # The pool serialises requests *per worker* but parallelises across
    # workers, so two clients running `/api/engine/analyse` no longer
    # queue on the same engine. Each worker costs ~256MB of RAM with
    # the default hash table.
    stockfish_pool_size: int = 2

    host: str = "127.0.0.1"
    port: int = 8000

    # When the server is exposed publicly (CHESS_HOST=0.0.0.0 for
    # ngrok/playit/etc), anyone with the URL can spoof another user's
    # client_id and overwrite their profile/match state. Setting
    # CHESS_AUTH_TOKEN to a non-empty shared secret gates every API +
    # WS endpoint behind that token. Clients receive it once via the
    # `?token=...` query parameter and persist it as an HttpOnly cookie
    # for subsequent requests. Empty (default) means "trust everyone
    # who can reach the socket" — fine for 127.0.0.1, dangerous
    # otherwise (the backend prints a loud warning at startup).
    auth_token: str = ""

    # Separate "host" secret. Only requests that present this token
    # (cookie / header / ``?host_token=`` query string) are allowed to
    # change the shared Stockfish engine configuration — threads, hash
    # MB, skill level, etc — because those settings are pooled across
    # every connected player. If the user doesn't export
    # ``CHESS_HOST_TOKEN`` we auto-generate one at startup via the
    # ``default_factory`` below — so the operator who launched the
    # server is the only one allowed to change shared engine settings
    # without any extra ceremony. The token is printed to stdout so
    # the operator can copy the host-only URL.
    host_token: str = ""

    def model_post_init(self, __context: object) -> None:
        # Auto-generate a host token if none was provided via env or
        # the .env file. This closes the "anyone on localhost can
        # reconfigure Stockfish" hole that the loopback-trust
        # fallback used to leave open. The operator sees the URL on
        # stdout; everyone else gets a read-only engine panel.
        if not self.host_token:
            object.__setattr__(self, "host_token", secrets.token_hex(16))

    frontend_dir: Path = Path(__file__).resolve().parent.parent / "frontend"
    backend_root: Path = Path(__file__).resolve().parent

    # Where mutable state lives (users / leaderboard / party history /
    # puzzle SQLite). Sits next to the bundled puzzle pack so the app
    # is fully self-contained for a local install.
    data_dir: Path = Path(__file__).resolve().parent / "data"

    def host_is_loopback(self) -> bool:
        """True iff ``host`` resolves to a loopback IP (127.x or ::1)."""
        try:
            return ipaddress.ip_address(self.host).is_loopback
        except ValueError:
            # Hostnames (e.g. "localhost") — accept only well-known
            # loopback names; everything else counts as public-facing.
            return self.host.strip().lower() in {"localhost", "ip6-localhost"}

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
