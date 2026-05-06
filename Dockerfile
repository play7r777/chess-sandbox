# syntax=docker/dockerfile:1.7

# ---------- Python runtime ----------
# Single-stage build: Debian's stockfish package is plenty for casual
# play / analysis (Stockfish 15.1 on Debian 12) and avoids dragging a
# 100MB toolchain image just to compile the engine. If we ever need a
# newer Stockfish we can swap this out for an official prebuilt binary
# from github.com/official-stockfish/Stockfish/releases.
FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
        stockfish ca-certificates libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/games/stockfish /usr/local/bin/stockfish \
    && /usr/local/bin/stockfish quit < /dev/null > /dev/null 2>&1 || true
WORKDIR /app
COPY pyproject.toml /app/pyproject.toml
COPY backend /app/backend
COPY frontend /app/frontend
RUN pip install --no-cache-dir .
# Persistent volume for users.json / leaderboard / party history.
ENV CHESS_DATA_DIR=/data \
    CHESS_HOST=0.0.0.0 \
    CHESS_PORT=8080 \
    CHESS_STOCKFISH_PATH=/usr/local/bin/stockfish
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8080"]
