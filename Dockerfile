# syntax=docker/dockerfile:1.7

# ---------- Stockfish builder ----------
# We compile Stockfish from source so the engine binary is available on
# Linux (no apt-get stockfish package needed) and matches the AVX2 build
# the local app expects. The compiled binary lands at /stockfish.
FROM debian:12-slim AS stockfish-build
ARG STOCKFISH_REF=sf_18
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ca-certificates git \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /tmp
RUN git clone --depth 1 --branch ${STOCKFISH_REF} https://github.com/official-stockfish/Stockfish.git \
    && cd Stockfish/src \
    && make -j"$(nproc)" build ARCH=x86-64-modern \
    && strip stockfish \
    && cp stockfish /stockfish

# ---------- Python runtime ----------
FROM python:3.12-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=stockfish-build /stockfish /usr/local/bin/stockfish
RUN chmod +x /usr/local/bin/stockfish
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
