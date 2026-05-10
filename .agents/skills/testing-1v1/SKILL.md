---
name: testing-1v1
description: End-to-end test the 1 vs 1 live multiplayer flow on chess-sandbox. Use when verifying any change that touches the 1 vs 1 challenge/accept/move/clock pipeline, the WebSocket handlers in backend/onevsone.py, the frontend match state in `_onevsoneHandleWsEvent` / `tryOneVsOneMove`, or the cache-buster on `backend/main.py`'s root/SPA fallback.
---

# Testing the 1 vs 1 multiplayer flow

This skill is for live, two-player, browser-based testing of `1 vs 1` matches against the FastAPI server. Unit tests cover the move-validation primitives; this skill is for the integration path that actually broke in the historical "white pawn teleports back to e2 and clock snaps to 5:00" regression.

## When to use

- Any PR touching `backend/onevsone.py`, especially `apply_move()`, the WebSocket handlers, or the match state machine.
- Any PR touching `frontend/app.js` 1 vs 1 code paths: `_onevsoneHandleWsEvent`, `tryOneVsOneMove`, `_onevsoneSendMove`, `_renderOnevsoneMatchUi`, or the optimistic-update logic.
- Any PR touching `backend/main.py`'s `root()` / `serve_frontend()` / `_index_html_with_cache_busters()`.
- Any reported regression with phrases like "piece teleports back", "clock resets to 5:00", "opponent doesn't see my move", or "split-second move".

## Setup: two independent browser sessions

1 vs 1 needs two real users with independent cookies/localStorage. The Devin VM has one Chrome instance pre-launched with `--user-data-dir=/home/ubuntu/.browser_data_dir`. To get a second independent session, spawn a *separate* Chrome process with a *different* user-data-dir:

```bash
mkdir -p /home/ubuntu/.browser_data_dir_bob
DISPLAY=:0 /opt/.devin/chrome/chrome/linux-133.0.6943.126/chrome-linux64/chrome \
  --user-data-dir=/home/ubuntu/.browser_data_dir_bob \
  --no-sandbox --disable-gpu \
  --window-size=900,1000 --window-position=720,40 \
  --no-first-run --no-default-browser-check \
  "http://127.0.0.1:8001/" 2>/dev/null & disown
```

This directory persists between sessions, so on subsequent runs Bob's nickname is already registered. If you need to reset Bob, `rm -rf /home/ubuntu/.browser_data_dir_bob`.

Do **not** try `google-chrome --new-window --incognito` — the existing Chrome's user-data-dir is locked, and the spawn will silently fail.

Do **not** use Playwright with CDP if you want the actions to appear in a screen recording. Playwright contexts created via CDP are headless from the desktop's point of view. Either drive both windows via the `computer` tool, or accept that Bob's actions won't be visible on screen and call them out in the test report.

## Window arrangement for recording

The responsive layout collapses the lobby/match panel below the chess board on narrow widths, which makes the panel invisible at 800px wide. For the *challenge issue* step Alice's window needs to be wide (≥ ~1000 px) so the lobby is visible; once the match starts the side-by-side 800/800 layout works fine because the move list is read out of the DOM via `aside.section`'s text (which is still emitted as `offscreen="true"` but readable).

Reliable arrangement commands:

```bash
# Side-by-side for play
sudo apt-get install -y wmctrl 2>/dev/null
wmctrl -i -r <ALICE_WID> -e 0,0,0,800,1100
wmctrl -i -r <BOB_WID>   -e 0,800,0,800,1100
```

`wmctrl -lG` shows window IDs and current geometry. Alice is the window owned by the original `--user-data-dir=/home/ubuntu/.browser_data_dir`; Bob is the new one.

Do NOT use `xdotool key super+Up` to maximize — many WMs interpret it as half-screen tile, not maximize.

## The flow

1. **Confirm Alice is logged in.** The original Chrome usually persists "Alice" from a prior session. If not, register her with the welcome modal.
2. **Register Bob in the second window.** Welcome modal → enter `Bob` → scroll if needed → click "Создать профиль". Then click `1 vs 1` in the header.
3. **Wait for the heartbeat.** Both users need to be marked `в сети` (green dot) in each other's player list. Takes ~5–10 s after page load. If Bob shows `не в сети` in Alice's list, give it a few more seconds.
4. **Issue challenge from Alice.** Click Bob's row → `Челлендж` button on the popup card → pick `5 мин`, `Белые` (so Alice is white — the failure mode is white-specific) → `Отправить вызов`.
5. **Accept on Bob's side.** A toast "Челлендж от Alice" appears in the bottom-right of Bob's window. Click `Принять`.
6. **Play moves.** Drag from source to destination using `left_click_drag` with `start_coordinate` and `coordinate`. Coordinates depend on the current window layout — read them off the screenshot, don't hardcode.
7. **Verify the post-conditions** (see below).

## What to assert after each move

The historical bug had a very specific signature. After Alice plays e2-e4, all of these must be true:

- The white pawn is on e4 in **Alice's** window (no teleport back to e2).
- The white pawn is on e4 in **Bob's** window (the move broadcast went through).
- The match panel's move list shows `e4` (read it from the DOM — the `aside` is often offscreen-rendered but the text is still in the HTML output of `computer act`).
- Alice's clock is **less than** the value it was at when she made the move, and is **NOT** equal to `5:00`. The original bug snapped Alice's clock back to 5:00 on her own side only.
- Bob's clock is now ticking (it was paused before).
- The status flipped from `Ваш ход` → `Ход соперника` on Alice's side, and `Ход соперника` → `Ваш ход` on Bob's side.
- The FEN field (input devinid varies) shows `4P3` on rank 4, confirming the server's authoritative state matches.

If any of these fail, the regression is back. Capture screenshots from both windows immediately.

## Known historical bug — what to watch for

The pre-fix client unconditionally appended `q` to every UCI move string in `_onevsoneSendMove(move.from + move.to + (move.promotion || "") + "q")` (or equivalent). `python-chess` happily parses `e2e4q` as a Move with `promotion = QUEEN`, but `is_legal` rejects it because there's no pawn on rank 8. Server returned `{type:"error",code:"illegal"}`, and the WS error handler refetched the pre-move match snapshot, causing the visible "piece teleports back + clock snap to 5:00" symptom on the offending client only.

The full fix has three layers:

1. **Frontend (the actual bug fix):** `tryOneVsOneMove` no longer appends `q` for non-promotion moves.
2. **Server-side tolerance:** `apply_move()` retries with the trailing promotion stripped if `chess.Move.from_uci(uci)` produced a Move with `promotion` set that isn't in `legal_moves`.
3. **Cache-buster:** `_index_html_with_cache_busters()` rewrites `index.html` to append `?v=<mtime>` to `app.js` and `style.css` so that a fresh deploy invalidates stale browser caches.

When testing, exercise all three:

- Live UCI path is exercised by playing any move (frontend layer 1).
- Server tolerance can be exercised in isolation by feeding `e2e4q` directly via WebSocket from a Python harness — this was done out-of-band in the prior session and should be redone if `apply_move` is touched.
- Cache-buster check is a one-shot: `curl -sS http://127.0.0.1:8001/ | grep -E '(app\.js|style\.css)'` should show `?v=<unix mtime>` on both, and `touch frontend/app.js && curl …` should show the version increment.

## Server start

If the server isn't already running, start it from the repo root:

```bash
cd /home/ubuntu/repos/chess-sandbox
uv run uvicorn backend.main:app --host 127.0.0.1 --port 8001 &
```

The blueprint may already start it during environment init — `curl -s http://127.0.0.1:8001/ -o /dev/null -w "%{http_code}\n"` returning `200` means it's up. Always check first instead of unconditionally launching, otherwise you'll get an `address already in use` error.

## Devin Secrets Needed

None. The 1 vs 1 flow uses anonymous nicknames stored client-side; no API keys, no SSO, no DB credentials beyond what the local FastAPI process already configures itself.

## Reporting

- Always post **one** consolidated GitHub comment on the PR, with `<details>` blocks per test, an inline screenshot per test, and a top-level pass/fail table. Do not spam separate comments.
- Always include the Devin session URL at the bottom of the PR comment.
- The user values screenshots from *both* windows for each meaningful state change — single-window screenshots leave open the question of whether the move actually replicated to the opponent.
- The test recording must show full Alice ↔ Bob interaction. If for any reason Bob's actions are scripted (Playwright), call it out explicitly in the report — visible interaction is the user's preferred evidence.
