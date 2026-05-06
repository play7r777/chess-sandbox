#!/usr/bin/env bash
# Запуск Chess Sandbox с публичным URL (ngrok / playit.gg).
#
# Аналог scripts/start-public.ps1 для Linux / macOS.
#
# Примеры:
#   ./scripts/start-public.sh                # ngrok
#   ./scripts/start-public.sh --tunnel playit
#   ./scripts/start-public.sh --tunnel none --port 9000
#
# ngrok нужно поставить отдельно: https://ngrok.com/download
# playit.gg: https://playit.gg/download
set -euo pipefail

TUNNEL="ngrok"
PORT=8001
while [[ $# -gt 0 ]]; do
    case "$1" in
        -t|--tunnel) TUNNEL="$2"; shift 2 ;;
        -p|--port)   PORT="$2"; shift 2 ;;
        -h|--help)
            sed -n '2,15p' "$0" | sed 's/^# *//'
            exit 0 ;;
        *) echo "Неизвестный аргумент: $1" >&2; exit 1 ;;
    esac
done

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PY="$REPO_ROOT/.venv/bin/python"
[[ -x "$PY" ]] || PY="$(command -v python3 || true)"
if [[ -z "$PY" ]]; then
    echo "Не нашёл python ни в .venv, ни в PATH." >&2
    exit 1
fi

export CHESS_HOST=0.0.0.0
export CHESS_PORT="$PORT"

echo "→ Старт сервера на 0.0.0.0:$PORT ..."
"$PY" -m uvicorn backend.main:app --host 0.0.0.0 --port "$PORT" &
SERVER_PID=$!

cleanup() {
    [[ -n "${TUNNEL_PID:-}" ]] && kill "$TUNNEL_PID" 2>/dev/null || true
    kill "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

sleep 2

case "$TUNNEL" in
    ngrok)
        if ! command -v ngrok >/dev/null 2>&1; then
            echo "ngrok не найден. Скачай: https://ngrok.com/download" >&2
            exit 1
        fi
        echo "→ Старт ngrok ..."
        ngrok http "$PORT" --log=stdout >/tmp/chess-ngrok.log 2>&1 &
        TUNNEL_PID=$!
        URL=""
        for _ in $(seq 1 20); do
            sleep 0.5
            URL="$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null \
                | python3 -c 'import json,sys; d=json.load(sys.stdin); ts=[t for t in d.get("tunnels",[]) if t.get("proto")=="https"]; print(ts[0]["public_url"] if ts else "")' 2>/dev/null || true)"
            [[ -n "$URL" ]] && break
        done
        if [[ -n "$URL" ]]; then
            echo
            echo "✓ Публичный URL: $URL"
            echo "  Скинь кентам — они открывают в браузере и играют."
            echo
        else
            echo "Не смог достучаться до ngrok API (http://127.0.0.1:4040)."
            echo "Лог: /tmp/chess-ngrok.log"
        fi
        ;;
    playit)
        if ! command -v playit >/dev/null 2>&1; then
            echo "playit не найден. Скачай: https://playit.gg/download" >&2
            exit 1
        fi
        echo "→ Старт playit ..."
        playit &
        TUNNEL_PID=$!
        echo
        echo "playit запущен. Дальше:"
        echo "  1. Открой https://playit.gg/account/tunnels/add"
        echo "  2. Тип: HTTPS, Local port: $PORT"
        echo "  3. Получишь URL вида https://*.playit.gg — скинь кентам."
        echo
        ;;
    none)
        echo "Сервер слушает 0.0.0.0:$PORT. Туннель подними сам."
        ;;
    *)
        echo "Неизвестный --tunnel: $TUNNEL (нужно ngrok | playit | none)" >&2
        exit 1 ;;
esac

echo "Ctrl+C чтобы остановить."
wait "$SERVER_PID"
