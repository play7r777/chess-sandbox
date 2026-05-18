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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

# Resolve a tunnel binary by name. Looks in scripts/, then repo root,
# then PATH.
resolve_bin() {
    local name="$1"
    if [[ -x "$SCRIPT_DIR/$name" ]]; then echo "$SCRIPT_DIR/$name"; return 0; fi
    if [[ -x "$REPO_ROOT/$name"   ]]; then echo "$REPO_ROOT/$name";   return 0; fi
    command -v "$name" 2>/dev/null && return 0
    return 1
}

PY="$REPO_ROOT/.venv/bin/python"
[[ -x "$PY" ]] || PY="$(command -v python3 || true)"
if [[ -z "$PY" ]]; then
    echo "Не нашёл python ни в .venv, ни в PATH." >&2
    exit 1
fi

export CHESS_HOST=0.0.0.0
export CHESS_PORT="$PORT"

# Auto-generate CHESS_AUTH_TOKEN unless the user already exported one
# or explicitly opted into the insecure path. The backend now refuses
# to bind to a non-loopback host without a token because anyone with
# the public URL could otherwise forge client_id and clobber another
# player's profile.
if [[ "${CHESS_ALLOW_INSECURE_PUBLIC:-0}" != "1" && -z "${CHESS_AUTH_TOKEN:-}" ]]; then
    if command -v python3 >/dev/null 2>&1; then
        CHESS_AUTH_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
    else
        CHESS_AUTH_TOKEN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
    export CHESS_AUTH_TOKEN
    echo "→ Сгенерирован CHESS_AUTH_TOKEN=$CHESS_AUTH_TOKEN"
fi

# Auto-generate CHESS_HOST_TOKEN. Only the operator's URL gets this
# baked in (printed below as the "host URL"); the URL shared with
# friends keeps CHESS_AUTH_TOKEN only, so they can play but can't
# touch the shared Stockfish settings.
if [[ -z "${CHESS_HOST_TOKEN:-}" ]]; then
    if command -v python3 >/dev/null 2>&1; then
        CHESS_HOST_TOKEN="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
    else
        CHESS_HOST_TOKEN="$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    fi
    export CHESS_HOST_TOKEN
    echo "→ Сгенерирован CHESS_HOST_TOKEN=$CHESS_HOST_TOKEN (только для тебя)"
fi

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
        NGROK="$(resolve_bin ngrok || true)"
        if [[ -z "$NGROK" ]]; then
            echo "ngrok не найден." >&2
            echo "Положи ngrok в одно из: $SCRIPT_DIR, $REPO_ROOT, или \$PATH." >&2
            echo "Скачать: https://ngrok.com/download" >&2
            exit 1
        fi
        echo "→ Старт ngrok ($NGROK) ..."
        "$NGROK" http "$PORT" --log=stdout >/tmp/chess-ngrok.log 2>&1 &
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
            if [[ -n "${CHESS_AUTH_TOKEN:-}" ]]; then
                echo "  Скинь кентам: $URL/?token=$CHESS_AUTH_TOKEN"
            else
                echo "  Скинь кентам — они открывают в браузере и играют."
            fi
            if [[ -n "${CHESS_HOST_TOKEN:-}" ]]; then
                if [[ -n "${CHESS_AUTH_TOKEN:-}" ]]; then
                    echo "  Твой host URL: $URL/?token=$CHESS_AUTH_TOKEN&host_token=$CHESS_HOST_TOKEN"
                else
                    echo "  Твой host URL: $URL/?host_token=$CHESS_HOST_TOKEN"
                fi
            fi
            echo
        else
            echo "Не смог достучаться до ngrok API (http://127.0.0.1:4040)."
            echo "Лог: /tmp/chess-ngrok.log"
        fi
        ;;
    playit)
        PLAYIT="$(resolve_bin playit || true)"
        if [[ -z "$PLAYIT" ]]; then
            echo "playit не найден." >&2
            echo "Положи playit в одно из: $SCRIPT_DIR, $REPO_ROOT, или \$PATH." >&2
            echo "Скачать: https://playit.gg/download" >&2
            exit 1
        fi
        echo "→ Старт playit ($PLAYIT) ..."
        "$PLAYIT" &
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
