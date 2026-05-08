// Chess Sandbox — single-file frontend module.
//
// Responsibilities:
//   - Render and manage an 8x8 board with free-form piece placement.
//   - Drag-drop pieces (board ↔ board, palette → board, board → trash).
//   - Sync UI state ↔ FEN.
//   - Talk to the FastAPI backend for engine control and screenshot recognition.
//   - Run a "play vs Stockfish from this position" loop using chess.js for
//     local legality checks.

import { Chess } from "/static/lib/chess.js";

// When the page is opened through a Basic-Auth-protected tunnel
// (e.g. `https://user:pass@host/`), Chrome strips the credentials
// from the address bar but `document.baseURI` may still keep them,
// which makes `fetch("/api/...")` and the WebSocket constructor throw
// `Request cannot be constructed from a URL that includes credentials`.
// Resolve every relative request against an explicitly clean origin
// (`location.protocol + location.host`) so the wrapper is a no-op on
// normal hosting and only kicks in for credentialed tunnels.
const _CLEAN_ORIGIN = `${location.protocol}//${location.host}`;
const _origFetch = window.fetch.bind(window);
window.fetch = function patchedFetch(input, init) {
  if (typeof input === "string" && input.startsWith("/")) {
    return _origFetch(_CLEAN_ORIGIN + input, init);
  }
  return _origFetch(input, init);
};

// Persistent UI settings (localStorage). Falls back to defaults if unset.
const SETTINGS_KEY = "chess-sandbox/settings/v1";
const DEFAULT_PIECE_SET = "merida";
const DEFAULT_BOARD_THEME = "brown";

// Available board themes — each is either a flat colour pair (light, dark)
// or an `image` describing a full pre-rendered board sprite. When `image`
// is set the per-square light/dark backgrounds are dropped and the image
// is stretched across the whole 8×8 grid (see `applyBoardTheme`).
const BOARD_THEMES = {
  brown:      { name: "Brown",      light: "#edd6b0", dark: "#b88762", highlight: "rgba(220, 200, 90, 0.45)" },
  green:      { name: "Green",      light: "#eeeed2", dark: "#769656", highlight: "rgba(255, 240, 90, 0.45)" },
  blue:       { name: "Blue",       light: "#dee3e6", dark: "#788a94", highlight: "rgba(110, 180, 255, 0.40)" },
  icy:        { name: "Icy Sea",    light: "#e0eef5", dark: "#7fa3bd", highlight: "rgba(160, 220, 255, 0.50)" },
  wood:       { name: "Wood",       light: "#d6a478", dark: "#7a4c2a", highlight: "rgba(255, 200, 90, 0.40)" },
  marble:     { name: "Marble",     light: "#e8e2d4", dark: "#9d958a", highlight: "rgba(220, 200, 110, 0.45)" },
  ocean:      { name: "Ocean",      light: "#cfe6ee", dark: "#3a6a87", highlight: "rgba(110, 200, 255, 0.45)" },
  forest:     { name: "Forest",     light: "#d6e3c4", dark: "#3f6a3a", highlight: "rgba(255, 230, 100, 0.45)" },
  tournament: { name: "Tournament", light: "#c9c9c9", dark: "#5d6470", highlight: "rgba(180, 200, 255, 0.40)" },
  newspaper:  { name: "Newspaper",  light: "#ffffff", dark: "#9b9b9b", highlight: "rgba(255, 230, 90, 0.45)" },
  set1:       { name: "#1",         image: "/static/board-themes/set1.png", highlight: "rgba(255, 220, 90, 0.45)" },
  set2:       { name: "#2",         image: "/static/board-themes/set2.png", highlight: "rgba(255, 220, 90, 0.45)" },
  set3:       { name: "#3",         image: "/static/board-themes/set3.png", highlight: "rgba(255, 240, 90, 0.45)" },
};

// Available piece sets. Files live under /static/pieces/<key>/ and are
// open-source pulls from the lichess project (which kindly hosts them
// under permissive licenses). Names are mapped to the closest chess.com
// counterpart in the UI for familiarity, but the assets are independent.
// `ext` defaults to "svg" — set it explicitly for raster sets.
const PIECE_SETS = {
  merida:     { name: "Merida" },
  cburnett:   { name: "Classic" },
  alpha:      { name: "Alpha" },
  maestro:    { name: "Maestro" },
  california: { name: "California" },
  chessnut:   { name: "Glass" },
  staunty:    { name: "Staunty" },
  fantasy:    { name: "Fantasy" },
  pirouetti:  { name: "Wood" },
  set1:       { name: "#1", ext: "png" },
  set2:       { name: "#2", ext: "png" },
  set3:       { name: "#3", ext: "png" },
};

// Default colour for the legal-move dots / capture rings. Users can
// override this from the settings modal; we keep a single source of
// truth so the CSS variable, the picker, and the saved settings all
// agree.
const DEFAULT_LEGAL_DOT_COLOR = "#28c85a";

// Piece sizing defaults. Both numbers are percentages of the cell:
// `pieceSize` is the piece image's width/height, `pieceOffsetY`
// shifts the piece downward inside the cell (negative values shift
// it up). Tuned to match chess.com's resting placement.
const DEFAULT_PIECE_SIZE = 95;
const DEFAULT_PIECE_OFFSET_Y = 2;
const MIN_PIECE_SIZE = 50;
const MAX_PIECE_SIZE = 100;
const MIN_PIECE_OFFSET_Y = -10;
const MAX_PIECE_OFFSET_Y = 20;
function _clampPieceSize(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_PIECE_SIZE;
  return Math.max(MIN_PIECE_SIZE, Math.min(MAX_PIECE_SIZE, Math.round(v)));
}
function _clampPieceOffsetY(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_PIECE_OFFSET_Y;
  return Math.max(MIN_PIECE_OFFSET_Y, Math.min(MAX_PIECE_OFFSET_Y, Math.round(v)));
}

const DEFAULT_PV_ARROW_COUNT = 6;
const MAX_PV_ARROW_COUNT = 12;
const DEFAULT_BEST_LINE_LENGTH = 10;
const MAX_BEST_LINE_LENGTH = 24;
function _clampArrows(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_PV_ARROW_COUNT;
  return Math.max(1, Math.min(MAX_PV_ARROW_COUNT, Math.round(v)));
}
function _clampBestLine(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return DEFAULT_BEST_LINE_LENGTH;
  return Math.max(1, Math.min(MAX_BEST_LINE_LENGTH, Math.round(v)));
}
// Validates a CSS colour string the user typed/picked. We restrict to
// `#rgb` / `#rrggbb` because the colour input emits those, and a hex
// value drops trivially into rgba() expressions for the dot/ring fill.
function _isHexColor(s) {
  return typeof s === "string" && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s);
}

function loadSettings() {
  const fallback = {
    theme: DEFAULT_BOARD_THEME,
    pieces: DEFAULT_PIECE_SET,
    soundOn: true,
    pvArrowCount: DEFAULT_PV_ARROW_COUNT,
    bestLineLength: DEFAULT_BEST_LINE_LENGTH,
    legalDotColor: DEFAULT_LEGAL_DOT_COLOR,
    pieceSize: DEFAULT_PIECE_SIZE,
    pieceOffsetY: DEFAULT_PIECE_OFFSET_Y,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) || {};
    return {
      theme: BOARD_THEMES[parsed.theme] ? parsed.theme : DEFAULT_BOARD_THEME,
      pieces: PIECE_SETS[parsed.pieces] ? parsed.pieces : DEFAULT_PIECE_SET,
      soundOn: parsed.soundOn !== false,
      pvArrowCount: _clampArrows(parsed.pvArrowCount ?? DEFAULT_PV_ARROW_COUNT),
      bestLineLength: _clampBestLine(parsed.bestLineLength ?? DEFAULT_BEST_LINE_LENGTH),
      legalDotColor: _isHexColor(parsed.legalDotColor)
        ? parsed.legalDotColor
        : DEFAULT_LEGAL_DOT_COLOR,
      pieceSize: _clampPieceSize(parsed.pieceSize ?? DEFAULT_PIECE_SIZE),
      pieceOffsetY: _clampPieceOffsetY(parsed.pieceOffsetY ?? DEFAULT_PIECE_OFFSET_Y),
    };
  } catch { return fallback; }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const userSettings = loadSettings();
function getPieceSet() { return userSettings.pieces; }
function getPieceExt() {
  const set = PIECE_SETS[getPieceSet()];
  return (set && set.ext) || "svg";
}
// Convert "#rrggbb" / "#rgb" -> rgba() with the requested alpha. Used
// to fade the legal-dot picker colour into the board overlay.
function _hexToRgba(hex, alpha) {
  const m = String(hex || "").trim();
  let r = 40, g = 200, b = 90;
  if (/^#[0-9a-f]{3}$/i.test(m)) {
    r = parseInt(m[1] + m[1], 16);
    g = parseInt(m[2] + m[2], 16);
    b = parseInt(m[3] + m[3], 16);
  } else if (/^#[0-9a-f]{6}$/i.test(m)) {
    r = parseInt(m.slice(1, 3), 16);
    g = parseInt(m.slice(3, 5), 16);
    b = parseInt(m.slice(5, 7), 16);
  }
  const a = Math.max(0, Math.min(1, Number(alpha)));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function applyLegalDotColor() {
  const c = _isHexColor(userSettings.legalDotColor)
    ? userSettings.legalDotColor
    : DEFAULT_LEGAL_DOT_COLOR;
  document.documentElement.style.setProperty("--legal-dot", _hexToRgba(c, 0.55));
}

function applyPieceSizing() {
  const size = _clampPieceSize(userSettings.pieceSize);
  const offY = _clampPieceOffsetY(userSettings.pieceOffsetY);
  const root = document.documentElement;
  root.style.setProperty("--piece-size", `${size}%`);
  root.style.setProperty("--piece-offset-y", `${offY}%`);
}
applyPieceSizing();

function applyBoardTheme() {
  const t = BOARD_THEMES[userSettings.theme] || BOARD_THEMES[DEFAULT_BOARD_THEME];
  const root = document.documentElement;
  // Always update highlight tint.
  root.style.setProperty("--highlight", t.highlight);
  // Image-backed themes: the whole board uses one PNG/JPG; squares stay
  // transparent so the image shows through. Otherwise fall back to
  // per-square flat colours.
  if (t.image) {
    root.style.setProperty("--board-image", `url("${t.image}")`);
    root.style.setProperty("--light-sq", "transparent");
    root.style.setProperty("--dark-sq", "transparent");
    document.body.classList.add("board-theme-image");
  } else {
    root.style.setProperty("--board-image", "none");
    root.style.setProperty("--light-sq", t.light);
    root.style.setProperty("--dark-sq", t.dark);
    document.body.classList.remove("board-theme-image");
  }
  applyLegalDotColor();
}
applyBoardTheme();

// ---------- Board scaling ----------
// The board sits inside `.board-scale-wrap` and is scaled via the
// `--board-scale` CSS custom property on `.board-area`. Three drag
// handles (right edge, bottom edge, bottom-right corner) let the user
// resize the board live. We persist the chosen scale per session in
// localStorage so it survives reloads.
const BOARD_SCALE_MIN = 0.6;
const BOARD_SCALE_MAX = 1.6;
const BOARD_SCALE_STORAGE_KEY = "chess-sandbox.board-scale";
function _clampBoardScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return Math.max(BOARD_SCALE_MIN, Math.min(BOARD_SCALE_MAX, n));
}
function _loadBoardScale() {
  try {
    const raw = localStorage.getItem(BOARD_SCALE_STORAGE_KEY);
    if (raw == null) return 1;
    return _clampBoardScale(parseFloat(raw));
  } catch (_) { return 1; }
}
function _saveBoardScale(v) {
  try { localStorage.setItem(BOARD_SCALE_STORAGE_KEY, String(_clampBoardScale(v))); }
  catch (_) { /* private mode: ignore */ }
}
function applyBoardScale(v) {
  const s = _clampBoardScale(v);
  const area = document.querySelector(".board-area");
  if (!area) return;
  area.style.setProperty("--board-scale", String(s));
  _saveBoardScale(s);
}
function _initBoardScaleHandles() {
  const wrap = document.getElementById("board-scale-wrap");
  if (!wrap) return;
  applyBoardScale(_loadBoardScale());
  const handles = wrap.querySelectorAll(".board-scale-handle");
  if (!handles.length) return;
  // We measure base (unscaled) size of the wrap *once* per drag, then
  // compute the new scale from the dragged delta vs. that base. Using
  // getBoundingClientRect would conflate the scaled width and produce
  // runaway growth.
  const baseSize = () => {
    const cs = getComputedStyle(wrap);
    // The wrap has `width: min(...)` and aspect-ratio 1, so the
    // computed width equals the unscaled side. We still divide by the
    // current scale defensively, just in case the layout changes.
    const w = parseFloat(cs.width) || 0;
    const cur = _clampBoardScale(getComputedStyle(document.querySelector(".board-area")).getPropertyValue("--board-scale"));
    return cur > 0 ? w / cur : w;
  };
  handles.forEach((h) => {
    h.addEventListener("pointerdown", (ev) => {
      ev.preventDefault();
      const axis = h.dataset.axis || "xy";
      const startX = ev.clientX;
      const startY = ev.clientY;
      const base = baseSize();
      if (base <= 0) return;
      const startScale = _clampBoardScale(getComputedStyle(document.querySelector(".board-area")).getPropertyValue("--board-scale"));
      h.classList.add("is-dragging");
      document.body.classList.add("is-board-resizing");
      try { h.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
      const onMove = (mv) => {
        const dx = mv.clientX - startX;
        const dy = mv.clientY - startY;
        // Convert pixel delta to scale delta. A 1:1 mapping (delta /
        // base) feels right — dragging the right edge by 100px on a
        // 600px board grows the scale by ~0.16, which is responsive
        // but not jumpy.
        let delta;
        if (axis === "x") delta = dx / base;
        else if (axis === "y") delta = dy / base;
        else delta = Math.max(dx, dy) / base; // corner: follow whichever axis grows more
        applyBoardScale(startScale + delta);
      };
      const onUp = () => {
        h.classList.remove("is-dragging");
        document.body.classList.remove("is-board-resizing");
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    });
    // Double-click resets the scale to 1 — handy escape hatch when the
    // user drags too far in one direction.
    h.addEventListener("dblclick", (ev) => {
      ev.preventDefault();
      applyBoardScale(1);
    });
  });
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", _initBoardScaleHandles, { once: true });
} else {
  _initBoardScaleHandles();
}

// ----- Move sounds (real .wav assets shipped under /static/sounds) -----
//
// Mirrors chess.com semantics: each chess event (plain move, capture,
// castle, promote, check, illegal) plays its own short sample. We use
// HTMLAudioElement here — `Audio.cloneNode()` cheaply gives us an
// independent playback so two rapid moves never cancel each other.
const SOUND_FILES = {
  "move-self":     "/static/sounds/move-self.wav",
  "move-opponent": "/static/sounds/move-opponent.wav",
  "move-check":    "/static/sounds/move-check.wav",
  "capture":       "/static/sounds/capture.wav",
  "castle":        "/static/sounds/castle.wav",
  "promote":       "/static/sounds/promote.wav",
  "illegal":       "/static/sounds/illegal.wav",
};
const _soundCache = {};
function _getSound(name) {
  if (_soundCache[name]) return _soundCache[name];
  const url = SOUND_FILES[name];
  if (!url) return null;
  try {
    const a = new Audio(url);
    a.preload = "auto";
    _soundCache[name] = a;
    return a;
  } catch { return null; }
}
function _playWav(name) {
  if (!userSettings.soundOn) return;
  const base = _getSound(name);
  if (!base) return;
  try {
    // Cloning lets overlapping playbacks coexist without clobbering each
    // other (engine reply + animation can collide otherwise).
    const a = base.cloneNode();
    const p = a.play();
    if (p && typeof p.catch === "function") p.catch(() => { /* autoplay blocked */ });
  } catch { /* ignore */ }
}
// Pre-load all samples eagerly so the first move is never silent on
// poor connections.
Object.keys(SOUND_FILES).forEach(_getSound);

// Pick a sound key from a chess.js move object. `inCheck` is the result
// of `chess.isCheck()` (or `isCheckmate()`) AFTER the move was applied.
function _moveSoundKey(move, { isOwn, inCheck }) {
  if (inCheck) return "move-check";
  const flags = (move && move.flags) || "";
  if (flags.includes("p")) return "promote";
  if (flags.includes("k") || flags.includes("q")) return "castle";
  if (flags.includes("c") || flags.includes("e")) return "capture";
  return isOwn ? "move-self" : "move-opponent";
}
// SAN-only fallback used by the analysis review (we don't always have a
// chess.js move object there, just `move_san` from the backend).
function _moveSoundKeyFromSan(san, { isOwn }) {
  if (!san) return isOwn ? "move-self" : "move-opponent";
  if (/[+#]/.test(san)) return "move-check";
  if (/^O-O(-O)?/.test(san)) return "castle"; // O-O / O-O-O
  if (san.includes("=")) return "promote";
  if (san.includes("x")) return "capture";
  return isOwn ? "move-self" : "move-opponent";
}
function playMoveSoundFor(move, opts) { _playWav(_moveSoundKey(move, opts || {})); }
function playMoveSoundForSan(san, opts) { _playWav(_moveSoundKeyFromSan(san, opts || {})); }
function playIllegalSound() { _playWav("illegal"); }
// Back-compat: the settings toggle calls this to demo "sound is on".
function playMoveSound() { _playWav("move-self"); }

const SOUND_ON_PATH = "M17.33 17C16.93 17.43 16.5 17.47 16.06 17.07L15.93 16.94C15.5 16.54 15.46 16.04 15.86 15.61C16.69 14.44 16.99 13.21 16.99 11.91C16.99 10.71 16.72 9.53996 15.89 8.40996C15.49 7.97996 15.52 7.47996 15.96 7.03996L16.03 6.96996C16.46 6.53996 16.93 6.56996 17.33 6.99996C18.53 8.56996 19 10.27 19 11.9C19 13.6 18.57 15.37 17.33 17ZM20.67 21C20.27 21.47 19.8 21.47 19.37 21.03L19.3 20.96C18.87 20.53 18.87 20.06 19.27 19.59C21.17 17.29 22 14.62 22 11.92C22 9.28996 21.17 6.68996 19.23 4.38996C18.83 3.91996 18.83 3.45996 19.26 3.05996L19.39 2.92996C19.82 2.52996 20.29 2.52996 20.69 2.99996C22.96 5.66996 23.99 8.82996 23.99 11.93C23.99 15.1 22.99 18.3 20.66 21H20.67ZM14 1.49996V22.5C14 23.43 12.9 23.67 12.23 22.9L8.92999 19.1C8.25999 18.3 7.59999 18 6.55999 18H2.65999C0.65999 18 -0.0100098 17.33 -0.0100098 15.33V8.65996C-0.0100098 6.65996 0.65999 5.98995 2.65999 5.98995H6.55999C7.58999 5.68996 8.25999 5.68996 8.92999 4.88996L12.23 1.08996C12.9 0.319955 14 0.559955 14 1.48996V1.49996Z";
const SOUND_OFF_PATH = "M14 1.5V22.5C14 23.43 12.9 23.67 12.23 22.9L8.93 19.1C8.26 18.3 7.6 18 6.56 18H2.66C0.66 18 -0.01 17.33 -0.01 15.33V8.66C-0.01 6.66 0.66 5.99 2.66 5.99H6.56C7.59 5.99 8.26 5.69 8.93 4.89L12.23 1.09C12.9 0.32 14 0.56 14 1.49V1.5ZM23.41 13.41L21 15.83L18.59 13.41L17.17 14.83L19.59 17.24L17.17 19.66L18.59 21.07L21 18.66L23.41 21.07L24.83 19.66L22.41 17.24L24.83 14.83L23.41 13.41Z";
function refreshSoundButton() {
  const btn = document.getElementById("btn-sound");
  if (!btn) return;
  btn.setAttribute("aria-pressed", userSettings.soundOn ? "true" : "false");
  btn.title = userSettings.soundOn ? "Звук ходов: вкл" : "Звук ходов: выкл";
  btn.dataset.on = userSettings.soundOn ? "true" : "false";
  const path = btn.querySelector("svg path");
  if (path) path.setAttribute("d", userSettings.soundOn ? SOUND_ON_PATH : SOUND_OFF_PATH);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

// ----- Avatar rendering -----
//
// Avatars used to be a single emoji glyph. Players can now upload a
// real photo via the profile editor, in which case the persisted
// `avatar` field becomes a relative URL like `/api/avatars/<cid>.png`.
// Both shapes flow through the same string field, so every render
// site routes through this helper to pick the right output.

function _isAvatarImageUrl(s) {
  if (!s) return false;
  const t = String(s);
  return t.startsWith("/api/avatars/")
      || t.startsWith("http://")
      || t.startsWith("https://")
      || t.startsWith("data:image/");
}

// Drop avatar values that look like a URL prefix that an older client
// truncated (e.g. "/api/ava"). Without this they'd render as plain
// text and read like garbage on every scoreboard / leaderboard row.
function _looksLikeTruncatedAvatarUrl(s) {
  if (!s) return false;
  const t = String(s);
  return t.startsWith("/api/") && !t.startsWith("/api/avatars/");
}

// Returns an HTML string suitable for inlining into a template literal.
// `extraClass` is appended onto the wrapper (img or span). `fallback`
// is the glyph drawn for empty / non-URL avatars.
function avatarHtml(avatar, opts) {
  const o = opts || {};
  const extraClass = o.extraClass || "";
  const fallback = o.fallback || "♟";
  const sizePx = o.sizePx || null;
  if (_isAvatarImageUrl(avatar)) {
    const sizeStyle = sizePx ? ` style="width:${sizePx}px;height:${sizePx}px"` : "";
    return `<img src="${escapeHtml(avatar)}" alt="" class="avatar-img ${extraClass}"${sizeStyle} referrerpolicy="no-referrer">`;
  }
  const safe = _looksLikeTruncatedAvatarUrl(avatar) ? fallback : (avatar || fallback);
  return `<span class="avatar-glyph ${extraClass}">${escapeHtml(safe)}</span>`;
}

function pieceSvgUrl(piece, overrideSet) {
  // overrideSet lets the spectator render a different player's pieces
  // without touching the local user's settings.
  const setKey = overrideSet || getPieceSet();
  const set = PIECE_SETS[setKey] || PIECE_SETS[getPieceSet()];
  const ext = (set && set.ext) || "svg";
  const color = piece === piece.toUpperCase() ? "w" : "b";
  return `/static/pieces/${setKey}/${color}${piece.toUpperCase()}.${ext}`;
}

function makePieceImg(piece, options = {}) {
  const img = document.createElement("img");
  img.src = pieceSvgUrl(piece);
  img.alt = piece;
  img.draggable = true;
  img.className = "piece-img " + (piece === piece.toUpperCase() ? "white" : "black");
  if (options.size) {
    img.style.width = options.size;
    img.style.height = options.size;
  }
  return img;
}

// Crossed-swords inline SVG used everywhere we used to put a 🎉 emoji
// next to the word "Party". The Battle tab is the same icon at 22px.
const BATTLE_SWORDS_SVG = `<svg width="18" height="18" viewBox="0 0 90 90" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M29.652 80.702c.645.552 2.736-1.185 3.614-2.038 2.022-1.985-1.443-7.507-2.824-9.105 0 0-5.225-5.985-9.118-9.28-1.559-1.425-6.99-5.016-9.013-3.031-.878.861-2.655 2.92-2.11 3.58L29.66 80.702h-.008zM14.095 82.347s-.596 3.312-1.887 4.572a6.088 6.088 0 0 1-8.64-.097c-2.363-2.424-2.322-6.304.093-8.666 1.283-1.26 4.598-1.784 4.598-1.784l5.827 5.975h.008z" fill="#666564"/><path d="m23.587 74.506-9.583 7.772-5.827-5.975 7.92-9.407 7.49 7.61z" fill="#666564"/><path d="M23.586 74.507s-2.722-2.512-10.824-3.65l3.334-3.961 7.49 7.611z" fill="#4B4847"/><path d="m39.59 62.773 40.746-39.075c5.802-5.694 5.3-15.52 5.3-15.52s-9.782-.718-15.584 4.977L29.269 52.267l4.994 5.417 5.328 5.089z" fill="#BEBDB9"/><path d="M70.053 13.155c5.802-5.695 15.585-4.978 15.585-4.978L72.992 20.364l-1.201-1.767a4.254 4.254 0 0 0-3.888-1.849l-1.757.154 3.907-3.747z" fill="#E7E6E5"/><path d="M60.35 80.702c-.646.552-2.737-1.185-3.615-2.038-2.022-1.985 1.443-7.507 2.824-9.105 0 0 5.225-5.985 9.118-9.28 1.559-1.425 6.99-5.016 9.013-3.031.878.861 2.655 2.92 2.11 3.58L60.341 80.702h.008zM75.907 82.347s.595 3.312 1.886 4.572a6.089 6.089 0 0 0 8.64-.097c2.363-2.424 2.322-6.304-.093-8.666-1.283-1.26-4.597-1.784-4.597-1.784l-5.828 5.975h-.008z" fill="#666564"/><path d="m66.414 74.506 9.583 7.772 5.827-5.975-7.92-9.407-7.49 7.61z" fill="#666564"/><path d="M66.415 74.507s2.722-2.512 10.824-3.65l-3.335-3.961-7.49 7.611z" fill="#4B4847"/><path d="M50.41 62.773 9.665 23.698c-5.802-5.694-5.3-15.52-5.3-15.52s9.782-.718 15.584 4.977l40.783 39.112-4.993 5.417-5.329 5.089z" fill="#BEBDB9"/><path d="M19.948 13.155C14.145 7.46 4.363 8.177 4.363 8.177l12.646 12.187 1.2-1.767a4.254 4.254 0 0 1 3.889-1.849l1.757.154-3.907-3.747z" fill="#E7E6E5"/></svg>`;

const PIECE_TYPES_WHITE = ["K", "Q", "R", "B", "N", "P"];
const PIECE_TYPES_BLACK = ["k", "q", "r", "b", "n", "p"];
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const STARTPOS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";

const state = {
  // Active high-level view ('main' | 'analysis' | 'puzzle'). Mirrored
  // by `document.body.classList`; tracked here so callers don't have to
  // poke the DOM to gate behaviour like puzzle move dispatch.
  view: "main",
  // Local user identity (nickname/avatar) loaded from localStorage and
  // synced to the backend so the leaderboard sees this client.
  user: { client_id: null, nickname: "", avatar: "♟", rating: 0, elo_history: null },
  // Active party / co-op puzzle session, if any.
  party: {
    active: false,       // true between WS open and "finish" message
    ws: null,
    code: null,
    party_id: null,
    host_id: null,
    status: "lobby",     // lobby | playing | finished
    endsAt: 0,
    startedAt: 0,
    members: [],
    scoreboard: [],
    finalResults: null,
    finalMeta: null,     // { duration_sec, started_at, ended_at, party_id }
    selfScore: 0,
    countdownInterval: null,
    // Match length (sec) — fixed at 180 (3 min) chess.com Battle style.
    // The host doesn't pick it any more; the field stays here so the
    // legacy "start" / "match_state" / "finish" handlers that read
    // ``state.party.durationSec`` keep working.
    durationSec: 180,
    allowedDurations: [180],
    // Number of lives each player starts with — mirrored from the
    // server (`lives_per_player` in the lobby state). Used to size
    // the "lives row" of the streak-grid scoreboard.
    livesPerPlayer: 3,
    // Cells per vertical column in the streak grid; new column opens
    // every Nth solved/failed puzzle.
    gridColHeight: 10,
    // Puzzle-rating mode picked by the host: "standard" (server uses
    // the lobby's avg ELO ± a band) or "custom" (server uses the
    // explicit [ratingMin, ratingMax] window). Mirrored from the
    // server's lobby/match_state messages so non-host members see the
    // chosen mode read-only and the post-match results render the
    // right badge.
    mode: "standard",
    ratingMin: 0,
    ratingMax: 0,
    // Local "I've been eliminated" flag — set to true after we receive
    // the "eliminated" WS frame so the puzzle UI / scoreboard can
    // dim our row, lock our board, and stop us from hammering the
    // hint/skip buttons. Cleared on the next match start / leave.
    selfEliminated: false,
  },
  // Spectator session (view-only, separate from `party`).
  spectator: {
    active: false,
    ws: null,
    code: null,
    party_id: null,
    status: "lobby",
    endsAt: 0,
    players: {},        // client_id -> { fen, score, solved, ... }
    cursors: {},        // client_id -> { x, y, flipped, selected, dragging, ... }
    scoreboard: [],
    selectedId: null,
    mode: "single",     // single | grid
    // When true, this spectator session is following a *solo* player
    // (presence WS), not a party. The renderer treats both kinds the
    // same once the data is in `players[cid]` / `cursors[cid]`, but
    // we need to know which WS to route lifecycle messages through.
    kind: "party",      // "party" | "presence"
  },
  // Solo-broadcast session — open whenever the user is solving puzzles
  // outside a party. Lets other users watch them via the "Оффлайн"
  // tab. Single connection; closed when the user enters a party or
  // leaves the puzzle view.
  presence: {
    active: false,
    ws: null,
    // Last known dedupe key for selection broadcasts so we don't spam
    // the wire on every renderBoard().
    lastSelectionKey: undefined,
  },
  // Inbound notifications (party invites etc.) from SSE.
  notifications: {
    es: null,           // EventSource
    invitations: {},    // invite_id -> invitation payload
    reconnectTimer: null,
  },
  // 64-cell array indexed 0..63 where 0 = a8, 7 = h8, 56 = a1, 63 = h1.
  // Each cell is a piece char (e.g. 'P','k') or null.
  board: new Array(64).fill(null),
  sideToMove: "w",
  castling: { K: true, Q: true, k: true, q: true },
  epSquare: "-",
  halfmove: 0,
  fullmove: 1,
  flipped: false,
  eraseMode: false,
  selectedSquare: null,
  legalTargets: [], // squares (e.g., "e4") highlighted as legal moves
  lastMove: null,   // { from: "e2", to: "e4" }
  legalMode: true,  // true = enforce legal chess moves; false = freeform sandbox
  freeplay: {
    chess: null,    // chess.js instance for off-engine legal play
  },
  history: [],      // FEN snapshots for undo stack
  redoStack: [],    // FEN snapshots for redo stack
  game: {
    active: false,
    chess: null,        // Chess instance from chess.js
    playerColor: "w",
    movetimeMs: 1000,
    history: [],        // SAN strings
    stopRequested: false,
  },
  engine: {
    running: false,
    path: null,
  },
  // Review-mode visuals.
  bestArrow: null,        // { from, to } — primary green arrow on board
  bestPv: null,           // [uci, uci, ...] — full best line for translucent PV arrows
  reviewBadge: null,      // { square, classification } — chess.com-style icon
  // Drill mode (practice critical moments).
  drill: {
    active: false,
    moments: [],          // copy of key_moments to walk through
    idx: 0,               // current moment index
    expectedUci: null,
    expectedSan: null,
    side: null,           // 'w' | 'b' — side to move in the drill position
    plyIdx: null,         // ply index in analysis (for navigation)
    feedback: null,       // 'correct' | 'wrong' | null
    // Per-attempt + run-level tracking for the chess.com-style summary.
    attempts: 0,             // wrong tries on the current moment
    hintUsed: false,         // "Подсказка" used on this moment?
    answerShown: false,      // "Показать" used on this moment?
    streak: 0,               // current consecutive solved-on-first-try
    bestStreak: 0,           // best streak this run
    outcomes: [],            // per-moment: 'solved' | 'solved-retry' | 'solved-hint' | 'given-up'
    startTime: 0,            // ms since epoch when run started
    finishedAt: 0,           // ms since epoch when run ended (for summary)
    finished: false,         // toggles summary screen in renderDrillUi
    sourceMoments: [],       // unfiltered list to allow "Заново"
  },
  // Puzzle mode (chess.com-style tactics trainer; data from Lichess pack).
  puzzle: {
    active: false,            // true while a puzzle is being solved
    current: null,            // serialized puzzle dict from /api/puzzle/random
    moves: [],                // full UCI list (setup move + alternating user/opponent)
    nextIdx: 0,               // index in `moves` of the next ply we're waiting on
    side: null,               // 'w' | 'b' — solver's side
    fenStart: null,           // FEN at puzzle start (before setup move)
    flippedSnapshot: null,    // board.flipped snapshot to restore on exit
    feedback: null,           // 'correct' | 'wrong' | 'solved' | 'shown' | null
    attempts: 0,              // wrong attempts on current ply (always 0 or 1 now)
    hintUsed: false,          // hint used on current puzzle?
    recentIds: [],            // last N served puzzle ids (anti-dup)
    history: [],              // [{ id, outcome, rating, themes, solveMs }]
    sessionRating: 1200,      // rolling personal rating (Glicko-lite)
    sessionStats: {           // counters for the stats bar
      solved: 0, wrong: 0, skipped: 0, streak: 0, bestStreak: 0,
    },
    startedAt: 0,             // ms when solver-state began (after setup move)
    solveMs: 0,               // ms to solve last puzzle (for display)
    pendingNext: null,        // setTimeout handle for auto-next after fail
    needsNextOnReturn: false, // user left mid-pendingNext; advance when they come back
    timerHandle: null,        // setInterval handle for live timer display
    idle: true,               // gate auto-load behind a "Начать игру" click
  },
  // Daily Puzzle — one shared puzzle per UTC day with leaderboard + streak.
  daily: {
    active: false,
    current: null,            // { id, fen, moves, side_to_solve, rating, themes, date }
    moves: [],
    nextIdx: 0,
    side: null,
    fenStart: null,
    flippedSnapshot: null,
    feedback: null,
    startedAt: 0,
    solveMs: 0,
    timerHandle: null,
    leaderboard: [],          // [{ client_id, nickname, avatar, solve_ms, attempts }]
    streak: 0,                // current streak (consecutive days)
    bestStreak: 0,
    solvedToday: false,
    failed: false,
    attemptsToday: 0,
    pendingNext: null,
  },
  // Puzzle Rush — timed (180/300s) or Survival (3 strikes) sprints.
  rush: {
    active: false,
    mode: null,               // "180" | "300" | "survival"
    deadlineAt: 0,
    durationSec: 0,
    startedAt: 0,
    score: 0,
    mistakes: 0,
    maxMistakes: 3,
    queue: [],
    fetchedTotal: 0,
    current: null,
    moves: [],
    nextIdx: 0,
    side: null,
    fenStart: null,
    flippedSnapshot: null,
    timerHandle: null,
    finished: false,
    finishReason: null,        // "time" | "mistakes" | "user-stop"
    sessionId: null,
    history: [],               // [{ id, rating, outcome, solveMs }]
    bestToday: { "180": 0, "300": 0, "survival": 0 },
    bestEver:  { "180": 0, "300": 0, "survival": 0 },
    leaderboard: { "180": [], "300": [], "survival": [] },
    leaderboardScope: "today", // "today" | "alltime"
    leaderboardMode: "180",
  },
  // Opening Trainer — pick an opening, theory + practice + mastery.
  opening: {
    active: false,
    catalog: [],               // [{ id, name, eco, color, lines: [{ id, name, moves, comments? }], description? }]
    selectedId: null,
    selectedLineId: null,
    mode: "theory",            // "theory" | "practice"
    chess: null,
    moveIdx: 0,
    feedback: null,
    flippedSnapshot: null,
    mastery: {},               // { lineId: { plays, correct, completed_at } }
    coachMsg: "",
    // AI coach (Ollama + Stockfish 18). status is one of:
    //   null      — not probed yet
    //   "checking"— probe in flight
    //   true/false — last probe outcome (true = Ollama up)
    aiCoach: {
      status: null,
      model: "",
      baseUrl: "",
      installedModels: [],
      stockfishRunning: false,
      streaming: false,
      text: "",
      error: "",
      lastSan: "",
      lastCorrect: null,
      lastPly: 0,
    },
  },
};

// ---------- Helpers: board indexing ----------

function squareNameFromIdx(idx) {
  const file = idx % 8;
  const rankFromTop = Math.floor(idx / 8);
  const rank = 8 - rankFromTop;
  return FILES[file] + rank;
}

function idxFromSquareName(name) {
  const file = FILES.indexOf(name[0]);
  const rank = parseInt(name[1], 10);
  if (file < 0 || !rank) return -1;
  return (8 - rank) * 8 + file;
}

// SVG-coord centre (in board-units, 0..8) for a given square name,
// honouring the current flip orientation. Used by the arrow overlay.
function squareToBoardXY(sq) {
  const fileIdx = FILES.indexOf(sq[0]);
  const rankIdx = parseInt(sq[1], 10);
  if (fileIdx < 0 || !rankIdx) return null;
  const visualCol = state.flipped ? 7 - fileIdx : fileIdx;
  const visualRow = state.flipped ? rankIdx - 1 : 8 - rankIdx;
  return { x: visualCol + 0.5, y: visualRow + 0.5 };
}

// SVG markup for the chess.com-style classification badges that
// float over the destination square. Each icon is a self-contained
// circle (drop shadow + colored background + white inner symbol)
// and renders at 100% of the badge container's box. Markup is
// adapted from chess.com's own Game Review icons so the visuals
// match pixel-for-pixel.
const REVIEW_BADGE_SVG = {
  brilliant: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#26c2a3" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <g opacity="0.2">
      <path d="M12.57,14.6a.51.51,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0h-2l-.13,0L10,14.84A.41.41,0,0,1,10,14.6V12.7A.32.32,0,0,1,10,12.5a.39.39,0,0,1,.1-.08l.13,0h2a.31.31,0,0,1,.24.1.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13Zm-.12-3.93a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H10.35a.31.31,0,0,1-.34-.31L9.86,3.9A.36.36,0,0,1,10,3.66a.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0H12.3a.32.32,0,0,1,.25.1.36.36,0,0,1,.09.24Z"/>
      <path d="M8.07,14.6a.51.51,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0h-2l-.13,0-.11-.08a.41.41,0,0,1-.08-.24V12.7a.27.27,0,0,1,0-.13.36.36,0,0,1,.07-.1.39.39,0,0,1,.1-.08l.13,0h2A.31.31,0,0,1,8,12.5a.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13ZM8,10.67a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H5.85a.31.31,0,0,1-.34-.31L5.36,3.9a.36.36,0,0,1,.09-.24.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0H7.8a.35.35,0,0,1,.25.1.36.36,0,0,1,.09.24Z"/>
    </g>
    <g>
      <path fill="#fff" d="M12.57,14.1a.51.51,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0h-2l-.13,0L10,14.34A.41.41,0,0,1,10,14.1V12.2A.32.32,0,0,1,10,12a.39.39,0,0,1,.1-.08l.13,0h2a.31.31,0,0,1,.24.1.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13Zm-.12-3.93a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H10.35a.31.31,0,0,1-.34-.31L9.86,3.4A.36.36,0,0,1,10,3.16a.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0H12.3a.32.32,0,0,1,.25.1.36.36,0,0,1,.09.24Z"/>
      <path fill="#fff" d="M8.07,14.1a.51.51,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0h-2l-.13,0-.11-.08a.41.41,0,0,1-.08-.24V12.2a.27.27,0,0,1,0-.13.36.36,0,0,1,.07-.1.39.39,0,0,1,.1-.08l.13,0h2A.31.31,0,0,1,8,12a.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13ZM8,10.17a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H5.85a.31.31,0,0,1-.34-.31L5.36,3.4a.36.36,0,0,1,.09-.24.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0H7.8a.35.35,0,0,1,.25.1.36.36,0,0,1,.09.24Z"/>
    </g>
  </svg>`,
  great: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#749bbf" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <g opacity="0.2">
      <path d="M10.32,14.6a.27.27,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0H8l-.13,0-.11-.08a.41.41,0,0,1-.08-.24V12.7a.27.27,0,0,1,0-.13.36.36,0,0,1,.07-.1.39.39,0,0,1,.1-.08l.13,0h2a.31.31,0,0,1,.24.1.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13Zm-.12-3.93a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H8.1a.31.31,0,0,1-.34-.31L7.61,3.9a.36.36,0,0,1,.09-.24.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0h2.11a.32.32,0,0,1,.25.1.36.36,0,0,1,.09.24Z"/>
    </g>
    <path fill="#fff" d="M10.32,14.1a.27.27,0,0,1,0,.13.44.44,0,0,1-.08.11l-.11.08-.13,0H8l-.13,0-.11-.08a.41.41,0,0,1-.08-.24V12.2a.27.27,0,0,1,0-.13.36.36,0,0,1,.07-.1.39.39,0,0,1,.1-.08l.13,0h2a.31.31,0,0,1,.24.1.39.39,0,0,1,.08.1.51.51,0,0,1,0,.13Zm-.12-3.93a.17.17,0,0,1,0,.12.41.41,0,0,1-.07.11.4.4,0,0,1-.23.08H8.1a.31.31,0,0,1-.34-.31L7.61,3.4a.36.36,0,0,1,.09-.24.23.23,0,0,1,.11-.08.27.27,0,0,1,.13,0h2.11a.32.32,0,0,1,.25.1.36.36,0,0,1,.09.24Z"/>
  </svg>`,
  best: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#81b64c" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <path opacity="0.2" d="M9,3.43a.5.5,0,0,0-.27.08.46.46,0,0,0-.17.22L7.24,7.17l-3.68.19a.52.52,0,0,0-.26.1.53.53,0,0,0-.16.23.45.45,0,0,0,0,.28.44.44,0,0,0,.15.23l2.86,2.32-1,3.56a.45.45,0,0,0,0,.28.46.46,0,0,0,.17.22.41.41,0,0,0,.26.09.43.43,0,0,0,.27-.08l3.09-2,3.09,2a.46.46,0,0,0,.53,0,.46.46,0,0,0,.17-.22.53.53,0,0,0,0-.28l-1-3.56L14.71,8.2A.44.44,0,0,0,14.86,8a.45.45,0,0,0,0-.28.53.53,0,0,0-.16-.23.52.52,0,0,0-.26-.1l-3.68-.2L9.44,3.73a.46.46,0,0,0-.17-.22A.5.5,0,0,0,9,3.43Z"/>
    <path fill="#fff" d="M9,2.93A.5.5,0,0,0,8.73,3a.46.46,0,0,0-.17.22L7.24,6.67l-3.68.19A.52.52,0,0,0,3.3,7a.53.53,0,0,0-.16.23.45.45,0,0,0,0,.28.44.44,0,0,0,.15.23L6.15,10l-1,3.56a.45.45,0,0,0,0,.28.46.46,0,0,0,.17.22.41.41,0,0,0,.26.09.43.43,0,0,0,.27-.08l3.09-2,3.09,2a.46.46,0,0,0,.53,0,.46.46,0,0,0,.17-.22.53.53,0,0,0,0-.28l-1-3.56L14.71,7.7a.44.44,0,0,0,.15-.23.45.45,0,0,0,0-.28A.53.53,0,0,0,14.7,7a.52.52,0,0,0-.26-.1l-3.68-.2L9.44,3.23A.46.46,0,0,0,9.27,3,.5.5,0,0,0,9,2.93Z"/>
  </svg>`,
  book: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#d5a47d" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <g opacity="0.3">
      <path d="M8.45,5.9c-1-.75-2.51-1.09-4.83-1.09H2.54v8.71H3.62a8.16,8.16,0,0,1,4.83,1.17Z"/>
      <path d="M9.54,14.69a8.14,8.14,0,0,1,4.84-1.17h1.08V4.81H14.38c-2.31,0-3.81.34-4.84,1.09Z"/>
    </g>
    <path fill="#fff" d="M8.45,5.4c-1-.75-2.51-1.09-4.83-1.09H3V13h.58a8.09,8.09,0,0,1,4.83,1.17Z"/>
    <path fill="#fff" d="M9.54,14.19A8.14,8.14,0,0,1,14.38,13H15V4.31h-.58c-2.31,0-3.81.34-4.84,1.09Z"/>
  </svg>`,
  mistake: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#ffa459" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <path opacity="0.2" d="M9.92,15a.27.27,0,0,1,0,.12.41.41,0,0,1-.07.11.32.32,0,0,1-.23.09H7.7a.25.25,0,0,1-.12,0,.27.27,0,0,1-.1-.08A.31.31,0,0,1,7.39,15V13.19A.32.32,0,0,1,7.48,13l.1-.07.12,0H9.59a.32.32,0,0,1,.23.09.61.61,0,0,1,.07.1.28.28,0,0,1,0,.13Zm2.2-7.17a3.1,3.1,0,0,1-.36.73,5.58,5.58,0,0,1-.49.6,6,6,0,0,1-.52.49,8,8,0,0,0-.65.63,1,1,0,0,0-.27.7v.22a.24.24,0,0,1,0,.12.17.17,0,0,1-.06.1.3.3,0,0,1-.1.07l-.12,0H7.79l-.12,0a.3.3,0,0,1-.1-.07.26.26,0,0,1-.07-.1.37.37,0,0,1,0-.12v-.35A2.42,2.42,0,0,1,7.61,10a2.55,2.55,0,0,1,.33-.66,3.38,3.38,0,0,1,.45-.55c.16-.15.33-.29.49-.42a7.73,7.73,0,0,0,.64-.64,1,1,0,0,0,.26-.67.77.77,0,0,0-.07-.34.75.75,0,0,0-.23-.27,1.16,1.16,0,0,0-.72-.24,1.61,1.61,0,0,0-.49.07,3,3,0,0,0-.41.18,1.41,1.41,0,0,0-.29.18l-.11.09a.5.5,0,0,1-.24.06A.31.31,0,0,1,7,6.69L6,5.48a.29.29,0,0,1,0-.4,1.36,1.36,0,0,1,.21-.2,3.07,3.07,0,0,1,.56-.38,5.38,5.38,0,0,1,.89-.37A3.75,3.75,0,0,1,8.9,4a4.07,4.07,0,0,1,1.2.19,4,4,0,0,1,1.09.56,2.76,2.76,0,0,1,.78.92,2.82,2.82,0,0,1,.28,1.28A3,3,0,0,1,12.12,7.85Z"/>
    <path fill="#fff" d="M9.92,14.52a.27.27,0,0,1,0,.12.41.41,0,0,1-.07.11.32.32,0,0,1-.23.09H7.7a.25.25,0,0,1-.12,0,.27.27,0,0,1-.1-.08.31.31,0,0,1-.09-.22V12.69a.32.32,0,0,1,.09-.23l.1-.07.12,0H9.59a.32.32,0,0,1,.23.09.61.61,0,0,1,.07.1.28.28,0,0,1,0,.13Zm2.2-7.17a3.1,3.1,0,0,1-.36.73,5.58,5.58,0,0,1-.49.6,6,6,0,0,1-.52.49,8,8,0,0,0-.65.63,1,1,0,0,0-.27.7v.22a.24.24,0,0,1,0,.12.17.17,0,0,1-.06.1.3.3,0,0,1-.1.07l-.12,0H7.79l-.12,0a.3.3,0,0,1-.1-.07.26.26,0,0,1-.07-.1.37.37,0,0,1,0-.12v-.35a2.42,2.42,0,0,1,.13-.84,2.55,2.55,0,0,1,.33-.66,3.38,3.38,0,0,1,.45-.55c.16-.15.33-.29.49-.42a7.73,7.73,0,0,0,.64-.64,1,1,0,0,0,.26-.67.77.77,0,0,0-.07-.34A.75.75,0,0,0,9.48,6a1.16,1.16,0,0,0-.72-.24,1.61,1.61,0,0,0-.49.07A3,3,0,0,0,7.86,6a1.41,1.41,0,0,0-.29.18l-.11.09a.5.5,0,0,1-.24.06A.31.31,0,0,1,7,6.19L6,5a.29.29,0,0,1,0-.4,1.36,1.36,0,0,1,.21-.2A3.07,3.07,0,0,1,6.81,4a5.38,5.38,0,0,1,.89-.37,3.75,3.75,0,0,1,1.2-.17,4.07,4.07,0,0,1,1.2.19,4,4,0,0,1,1.09.56,2.76,2.76,0,0,1,.78.92,2.82,2.82,0,0,1,.28,1.28A3,3,0,0,1,12.12,7.35Z"/>
  </svg>`,
  blunder: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#fa412d" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <g opacity="0.2">
      <path d="M14.74,5.45A2.58,2.58,0,0,0,14,4.54,3.76,3.76,0,0,0,12.89,4a4.07,4.07,0,0,0-1.2-.19A3.92,3.92,0,0,0,10.51,4a5.87,5.87,0,0,0-.9.37,3,3,0,0,0-.32.2,3.46,3.46,0,0,1,.42.63,3.29,3.29,0,0,1,.36,1.47.31.31,0,0,0,.19-.06l.11-.08a2.9,2.9,0,0,1,.29-.19,3.89,3.89,0,0,1,.41-.17,1.55,1.55,0,0,1,.48-.07,1.1,1.1,0,0,1,.72.24.72.72,0,0,1,.23.26.8.8,0,0,1,.07.34,1,1,0,0,1-.25.67,7.71,7.71,0,0,1-.65.63,6.2,6.2,0,0,0-.48.43,2.93,2.93,0,0,0-.45.54,2.55,2.55,0,0,0-.33.66,2.62,2.62,0,0,0-.13.83V11a.24.24,0,0,0,0,.12.35.35,0,0,0,.17.17l.12,0h1.71l.12,0a.23.23,0,0,0,.1-.07.21.21,0,0,0,.06-.1.27.27,0,0,0,0-.12V10.8a1,1,0,0,1,.26-.7q.27-.28.66-.63A5.79,5.79,0,0,0,14.05,9a4.51,4.51,0,0,0,.48-.6,2.56,2.56,0,0,0,.36-.72,2.81,2.81,0,0,0,.14-1A2.66,2.66,0,0,0,14.74,5.45Z"/>
      <path d="M12.38,12.65H10.5l-.12,0a.34.34,0,0,0-.18.29v1.82a.36.36,0,0,0,.08.23.23.23,0,0,0,.1.07l.12,0h1.88a.24.24,0,0,0,.12,0,.26.26,0,0,0,.11-.07.36.36,0,0,0,.07-.1.28.28,0,0,0,0-.13V13a.27.27,0,0,0,0-.12.61.61,0,0,0-.07-.1A.32.32,0,0,0,12.38,12.65Z"/>
      <path d="M6.79,12.65H4.91l-.12,0a.34.34,0,0,0-.18.29v1.82a.36.36,0,0,0,.08.23.23.23,0,0,0,.1.07l.12,0H6.79a.24.24,0,0,0,.12,0A.26.26,0,0,0,7,15a.36.36,0,0,0,.07-.1.28.28,0,0,0,0-.13V13a.27.27,0,0,0,0-.12.61.61,0,0,0-.07-.1A.32.32,0,0,0,6.79,12.65Z"/>
      <path d="M8.39,4.54A3.76,3.76,0,0,0,7.3,4a4.07,4.07,0,0,0-1.2-.19A3.92,3.92,0,0,0,4.92,4a5.87,5.87,0,0,0-.9.37,3.37,3.37,0,0,0-.55.38l-.21.19a.32.32,0,0,0,0,.41l1,1.2a.26.26,0,0,0,.2.12.48.48,0,0,0,.24-.06l.11-.08a2.9,2.9,0,0,1,.29-.19l.4-.17A1.66,1.66,0,0,1,6,6.06a1.1,1.1,0,0,1,.72.24.72.72,0,0,1,.23.26A.77.77,0,0,1,7,6.9a1,1,0,0,1-.26.67,7.6,7.6,0,0,1-.64.63,6.28,6.28,0,0,0-.49.43,2.93,2.93,0,0,0-.45.54,2.72,2.72,0,0,0-.33.66,2.62,2.62,0,0,0-.13.83V11a.43.43,0,0,0,0,.12.39.39,0,0,0,.08.1.18.18,0,0,0,.1.07.21.21,0,0,0,.12,0H6.72l.12,0a.23.23,0,0,0,.1-.07.36.36,0,0,0,.07-.1A.5.5,0,0,0,7,11V10.8a1,1,0,0,1,.27-.7A8,8,0,0,1,8,9.47c.18-.15.35-.31.52-.48A7,7,0,0,0,9,8.39a3.23,3.23,0,0,0,.36-.72,3.07,3.07,0,0,0,.13-1,2.66,2.66,0,0,0-.29-1.27A2.58,2.58,0,0,0,8.39,4.54Z"/>
    </g>
    <path fill="#fff" d="M14.74,5A2.58,2.58,0,0,0,14,4a3.76,3.76,0,0,0-1.09-.56,4.07,4.07,0,0,0-1.2-.19,3.92,3.92,0,0,0-1.18.17,5.87,5.87,0,0,0-.9.37,3,3,0,0,0-.32.2,3.46,3.46,0,0,1,.42.63,3.29,3.29,0,0,1,.36,1.47.31.31,0,0,0,.19-.06L10.37,6a2.9,2.9,0,0,1,.29-.19,3.89,3.89,0,0,1,.41-.17,1.55,1.55,0,0,1,.48-.07,1.1,1.1,0,0,1,.72.24.72.72,0,0,1,.23.26.8.8,0,0,1,.07.34,1,1,0,0,1-.25.67,7.71,7.71,0,0,1-.65.63,6.2,6.2,0,0,0-.48.43,2.93,2.93,0,0,0-.45.54,2.55,2.55,0,0,0-.33.66,2.62,2.62,0,0,0-.13.83v.35a.24.24,0,0,0,0,.12.35.35,0,0,0,.17.17l.12,0h1.71l.12,0a.23.23,0,0,0,.1-.07.21.21,0,0,0,.06-.1.27.27,0,0,0,0-.12V10.3a1,1,0,0,1,.26-.7q.27-.28.66-.63a5.79,5.79,0,0,0,.51-.48,4.51,4.51,0,0,0,.48-.6,2.56,2.56,0,0,0,.36-.72,2.81,2.81,0,0,0,.14-1A2.66,2.66,0,0,0,14.74,5Z"/>
    <path fill="#fff" d="M12.38,12.15H10.5l-.12,0a.34.34,0,0,0-.18.29v1.82a.36.36,0,0,0,.08.23.23.23,0,0,0,.1.07l.12,0h1.88a.24.24,0,0,0,.12,0,.26.26,0,0,0,.11-.07.36.36,0,0,0,.07-.1.28.28,0,0,0,0-.13V12.46a.27.27,0,0,0,0-.12.61.61,0,0,0-.07-.1A.32.32,0,0,0,12.38,12.15Z"/>
    <path fill="#fff" d="M6.79,12.15H4.91l-.12,0a.34.34,0,0,0-.18.29v1.82a.36.36,0,0,0,.08.23.23.23,0,0,0,.1.07l.12,0H6.79a.24.24,0,0,0,.12,0A.26.26,0,0,0,7,14.51a.36.36,0,0,0,.07-.1.28.28,0,0,0,0-.13V12.46a.27.27,0,0,0,0-.12.61.61,0,0,0-.07-.1A.32.32,0,0,0,6.79,12.15Z"/>
    <path fill="#fff" d="M8.39,4A3.76,3.76,0,0,0,7.3,3.48a4.07,4.07,0,0,0-1.2-.19,3.92,3.92,0,0,0-1.18.17,5.87,5.87,0,0,0-.9.37,3.37,3.37,0,0,0-.55.38l-.21.19a.32.32,0,0,0,0,.41l1,1.2a.26.26,0,0,0,.2.12.48.48,0,0,0,.24-.06L4.78,6a2.9,2.9,0,0,1,.29-.19l.4-.17A1.66,1.66,0,0,1,6,5.56a1.1,1.1,0,0,1,.72.24.72.72,0,0,1,.23.26A.77.77,0,0,1,7,6.4a1,1,0,0,1-.26.67,7.6,7.6,0,0,1-.64.63,6.28,6.28,0,0,0-.49.43,2.93,2.93,0,0,0-.45.54,2.72,2.72,0,0,0-.33.66,2.62,2.62,0,0,0-.13.83v.35a.43.43,0,0,0,0,.12.39.39,0,0,0,.08.1.18.18,0,0,0,.1.07.21.21,0,0,0,.12,0H6.72l.12,0a.23.23,0,0,0,.1-.07.36.36,0,0,0,.07-.1.5.5,0,0,0,0-.12V10.3a1,1,0,0,1,.27-.7A8,8,0,0,1,8,9c.18-.15.35-.31.52-.48A7,7,0,0,0,9,7.89a3.23,3.23,0,0,0,.36-.72,3.07,3.07,0,0,0,.13-1A2.66,2.66,0,0,0,9.15,5,2.58,2.58,0,0,0,8.39,4Z"/>
  </svg>`,
  miss: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5C4.03,.5,0,4.53,0,9.5s4.03,9,9,9,9-4.03,9-9S13.97,.5,9,.5Z"/>
    <path fill="#ff7769" d="M9,0C4.03,0,0,4.03,0,9s4.03,9,9,9,9-4.03,9-9S13.97,0,9,0Z"/>
    <path opacity="0.2" d="M13.99,12.51s.06,.08,.08,.13c.02,.05,.03,.1,.03,.15s-.01,.1-.03,.15c-.02,.05-.05,.09-.08,.13l-1.37,1.37s-.08,.06-.13,.08c-.05,.02-.1,.03-.15,.03s-.1-.01-.15-.03c-.05-.02-.09-.05-.13-.08l-3.06-3.06-3.06,3.06s-.08,.06-.13,.08c-.05,.02-.1,.03-.15,.03s-.1-.01-.15-.03c-.05-.02-.09-.05-.13-.08l-1.37-1.37c-.07-.07-.11-.17-.11-.28s.04-.2,.11-.28l3.06-3.06-3.06-3.06c-.07-.07-.11-.17-.11-.28s.04-.2,.11-.28l1.37-1.37c.07-.07,.17-.11,.28-.11s.2,.04,.28,.11l3.06,3.06,3.06-3.06c.07-.07,.17-.11,.28-.11s.2,.04,.28,.11l1.37,1.37s.06,.08,.08,.13c.02,.05,.03,.1,.03,.15s-.01,.1-.03,.15c-.02,.05-.05,.09-.08,.13l-3.06,3.06,3.06,3.06Z"/>
    <path fill="#fff" d="M13.99,12.01s.06,.08,.08,.13c.02,.05,.03,.1,.03,.15s-.01,.1-.03,.15c-.02,.05-.05,.09-.08,.13l-1.37,1.37s-.08,.06-.13,.08c-.05,.02-.1,.03-.15,.03s-.1-.01-.15-.03c-.05-.02-.09-.05-.13-.08l-3.06-3.06-3.06,3.06s-.08,.06-.13,.08c-.05,.02-.1,.03-.15,.03s-.1-.01-.15-.03c-.05-.02-.09-.05-.13-.08l-1.37-1.37c-.07-.07-.11-.17-.11-.28s.04-.2,.11-.28l3.06-3.06-3.06-3.06c-.07-.07-.11-.17-.11-.28s.04-.2,.11-.28l1.37-1.37c.07-.07,.17-.11,.28-.11s.2,.04,.28,.11l3.06,3.06,3.06-3.06c.07-.07,.17-.11,.28-.11s.2,.04,.28,.11l1.37,1.37s.06,.08,.08,.13c.02,.05,.03,.1,.03,.15s-.01,.1-.03,.15c-.02,.05-.05,.09-.08,.13l-3.06,3.06,3.06,3.06Z"/>
  </svg>`,
  excellent: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#81b64c" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <g opacity="0.2">
      <path d="M13.79,11.34c0-.2.4-.53.4-.94S14,9.72,14,9.58a2.06,2.06,0,0,0,.18-.83,1,1,0,0,0-.3-.69,1.13,1.13,0,0,0-.55-.2,10.29,10.29,0,0,1-2.07,0c-.37-.23,0-1.18.18-1.7S11.9,4,10.62,3.7c-.69-.17-.66.37-.78.9-.05.21-.09.43-.13.57A5,5,0,0,1,7.05,8.23a1.57,1.57,0,0,1-.42.18v4.94A7.23,7.23,0,0,1,8,13.53c.52.12.91.25,1.44.33A11.11,11.11,0,0,0,11,14a6.65,6.65,0,0,0,1.18,0,1.09,1.09,0,0,0,1-.59.66.66,0,0,0,.06-.2,1.63,1.63,0,0,1,.07-.3c.13-.28.37-.3.5-.68S13.74,11.53,13.79,11.34Z"/>
      <path d="M5.49,8.09H4.31a.5.5,0,0,0-.5.5v4.56a.5.5,0,0,0,.5.5H5.49a.5.5,0,0,0,.5-.5V8.59A.5.5,0,0,0,5.49,8.09Z"/>
    </g>
    <path fill="#fff" d="M13.79,10.84c0-.2.4-.53.4-.94S14,9.22,14,9.08a2.06,2.06,0,0,0,.18-.83,1,1,0,0,0-.3-.69,1.13,1.13,0,0,0-.55-.2,10.29,10.29,0,0,1-2.07,0c-.37-.23,0-1.18.18-1.7s.51-2.12-.77-2.43c-.69-.17-.66.37-.78.9-.05.21-.09.43-.13.57A5,5,0,0,1,7.05,7.73a1.57,1.57,0,0,1-.42.18v4.94A7.23,7.23,0,0,1,8,13c.52.12.91.25,1.44.33a11.11,11.11,0,0,0,1.62.16,6.65,6.65,0,0,0,1.18,0,1.09,1.09,0,0,0,1-.59.66.66,0,0,0,.06-.2,1.63,1.63,0,0,1,.07-.3c.13-.28.37-.3.5-.68S13.74,11,13.79,10.84Z"/>
    <path fill="#fff" d="M5.49,7.59H4.31a.5.5,0,0,0-.5.5v4.56a.5.5,0,0,0,.5.5H5.49a.5.5,0,0,0,.5-.5V8.09A.5.5,0,0,0,5.49,7.59Z"/>
  </svg>`,
  good: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#95b776" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <path opacity="0.2" d="M15.11,6.81,9.45,12.47,7.79,14.13a.39.39,0,0,1-.28.11.39.39,0,0,1-.27-.11L2.89,9.78a.39.39,0,0,1-.11-.28.39.39,0,0,1,.11-.27L4.28,7.85a.34.34,0,0,1,.12-.09l.15,0a.37.37,0,0,1,.15,0,.38.38,0,0,1,.13.09l2.69,2.68,5.65-5.65a.38.38,0,0,1,.13-.09.37.37,0,0,1,.15,0,.4.4,0,0,1,.15,0,.34.34,0,0,1,.12.09l1.39,1.38a.41.41,0,0,1,.08.13.33.33,0,0,1,0,.15.4.4,0,0,1,0,.15A.5.5,0,0,1,15.11,6.81Z"/>
    <path fill="#fff" d="M15.11,6.31,9.45,12,7.79,13.63a.39.39,0,0,1-.28.11.39.39,0,0,1-.27-.11L2.89,9.28A.39.39,0,0,1,2.78,9a.39.39,0,0,1,.11-.27L4.28,7.35a.34.34,0,0,1,.12-.09l.15,0a.37.37,0,0,1,.15,0,.38.38,0,0,1,.13.09L7.52,10l5.65-5.65a.38.38,0,0,1,.13-.09.37.37,0,0,1,.15,0,.4.4,0,0,1,.15,0,.34.34,0,0,1,.12.09l1.39,1.38a.41.41,0,0,1,.08.13.33.33,0,0,1,0,.15.4.4,0,0,1,0,.15A.5.5,0,0,1,15.11,6.31Z"/>
  </svg>`,
  inaccuracy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#f7c631" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <g opacity="0.2">
      <path d="M13.66,14.8a.28.28,0,0,1,0,.13.23.23,0,0,1-.08.11.28.28,0,0,1-.11.08l-.12,0h-2l-.13,0a.27.27,0,0,1-.1-.08A.36.36,0,0,1,11,14.8V12.9a.59.59,0,0,1,0-.13.36.36,0,0,1,.07-.1l.1-.08.13,0h2a.33.33,0,0,1,.23.1.39.39,0,0,1,.08.1.28.28,0,0,1,0,.13Zm-.12-3.93a.31.31,0,0,1,0,.13.3.3,0,0,1-.07.1.3.3,0,0,1-.23.08H11.43a.31.31,0,0,1-.34-.31L10.94,4.1A.5.5,0,0,1,11,3.86l.11-.08.13,0h2.11a.35.35,0,0,1,.26.1.41.41,0,0,1,.08.24Z"/>
      <path d="M7.65,14.82a.27.27,0,0,1,0,.12.26.26,0,0,1-.07.11l-.1.07-.13,0H5.43a.25.25,0,0,1-.12,0,.27.27,0,0,1-.1-.08.31.31,0,0,1-.09-.22V13a.36.36,0,0,1,.09-.23l.1-.07.12,0H7.32a.32.32,0,0,1,.23.09.3.3,0,0,1,.07.1.28.28,0,0,1,0,.13Zm2.2-7.17a3.1,3.1,0,0,1-.36.73A5.58,5.58,0,0,1,9,9a4.85,4.85,0,0,1-.52.49,8,8,0,0,0-.65.63,1,1,0,0,0-.27.7V11a.21.21,0,0,1,0,.12.17.17,0,0,1-.06.1.23.23,0,0,1-.1.07l-.12,0H5.53a.21.21,0,0,1-.12,0,.18.18,0,0,1-.1-.07.2.2,0,0,1-.08-.1.37.37,0,0,1,0-.12v-.35a2.68,2.68,0,0,1,.13-.84,2.91,2.91,0,0,1,.33-.66,3.38,3.38,0,0,1,.45-.55c.16-.15.33-.29.49-.42a7.84,7.84,0,0,0,.65-.64,1,1,0,0,0,.25-.67.77.77,0,0,0-.07-.34.67.67,0,0,0-.23-.27A1.16,1.16,0,0,0,6.49,6,1.61,1.61,0,0,0,6,6.11a3,3,0,0,0-.41.18,1.75,1.75,0,0,0-.29.18l-.11.09A.5.5,0,0,1,5,6.62a.31.31,0,0,1-.21-.13l-1-1.21a.3.3,0,0,1,0-.4A1.36,1.36,0,0,1,4,4.68a3.07,3.07,0,0,1,.56-.38,5.49,5.49,0,0,1,.9-.37,3.69,3.69,0,0,1,1.19-.17,3.92,3.92,0,0,1,2.3.75,2.85,2.85,0,0,1,.77.92A2.82,2.82,0,0,1,10,6.71,3,3,0,0,1,9.85,7.65Z"/>
    </g>
    <path fill="#fff" d="M13.66,14.3a.28.28,0,0,1,0,.13.23.23,0,0,1-.08.11.28.28,0,0,1-.11.08l-.12,0h-2l-.13,0a.27.27,0,0,1-.1-.08A.36.36,0,0,1,11,14.3V12.4a.59.59,0,0,1,0-.13.36.36,0,0,1,.07-.1l.1-.08.13,0h2a.33.33,0,0,1,.23.1.39.39,0,0,1,.08.1.28.28,0,0,1,0,.13Zm-.12-3.93a.31.31,0,0,1,0,.13.3.3,0,0,1-.07.1.3.3,0,0,1-.23.08H11.43a.31.31,0,0,1-.34-.31L10.94,3.6A.5.5,0,0,1,11,3.36l.11-.08.13,0h2.11a.35.35,0,0,1,.26.1.41.41,0,0,1,.08.24Z"/>
    <path fill="#fff" d="M7.65,14.32a.27.27,0,0,1,0,.12.26.26,0,0,1-.07.11l-.1.07-.13,0H5.43a.25.25,0,0,1-.12,0,.27.27,0,0,1-.1-.08.31.31,0,0,1-.09-.22V12.49a.36.36,0,0,1,.09-.23l.1-.07.12,0H7.32a.32.32,0,0,1,.23.09.3.3,0,0,1,.07.1.28.28,0,0,1,0,.13Zm2.2-7.17a3.1,3.1,0,0,1-.36.73,5.58,5.58,0,0,1-.49.6A4.85,4.85,0,0,1,8.48,9a8,8,0,0,0-.65.63,1,1,0,0,0-.27.7v.22a.21.21,0,0,1,0,.12.17.17,0,0,1-.06.1.23.23,0,0,1-.1.07l-.12,0H5.53a.21.21,0,0,1-.12,0,.18.18,0,0,1-.1-.07.2.2,0,0,1-.08-.1.37.37,0,0,1,0-.12v-.35a2.68,2.68,0,0,1,.13-.84,2.91,2.91,0,0,1,.33-.66,3.38,3.38,0,0,1,.45-.55c.16-.15.33-.29.49-.42a7.84,7.84,0,0,0,.65-.64,1,1,0,0,0,.25-.67.77.77,0,0,0-.07-.34.67.67,0,0,0-.23-.27,1.16,1.16,0,0,0-.72-.24A1.61,1.61,0,0,0,6,5.61a3,3,0,0,0-.41.18A1.75,1.75,0,0,0,5.3,6l-.11.09A.5.5,0,0,1,5,6.12.31.31,0,0,1,4.74,6l-1-1.21a.3.3,0,0,1,0-.4A1.36,1.36,0,0,1,4,4.18a3.07,3.07,0,0,1,.56-.38,5.49,5.49,0,0,1,.9-.37,3.69,3.69,0,0,1,1.19-.17A3.92,3.92,0,0,1,8.93,4a2.85,2.85,0,0,1,.77.92A2.82,2.82,0,0,1,10,6.21,3,3,0,0,1,9.85,7.15Z"/>
  </svg>`,
  forced: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#96af8b" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <path opacity="0.2" d="M14.39,9.07,9,4.31a.31.31,0,0,0-.3,0,.32.32,0,0,0-.13.1.29.29,0,0,0,0,.16V7.42H3.9a.58.58,0,0,0-.19,0,.5.5,0,0,0-.17.11.91.91,0,0,0-.11.16.63.63,0,0,0,0,.19v3.41a.58.58,0,0,0,0,.19.64.64,0,0,0,.11.16.39.39,0,0,0,.17.11.41.41,0,0,0,.19,0H8.5v2.74a.26.26,0,0,0,.16.26.3.3,0,0,0,.16,0A.34.34,0,0,0,9,14.79L14.39,10a.69.69,0,0,0,.16-.22.7.7,0,0,0,0-.52A.69.69,0,0,0,14.39,9.07Z"/>
    <path fill="#fff" d="M14.39,8.57,9,3.81a.31.31,0,0,0-.3,0,.32.32,0,0,0-.13.1A.29.29,0,0,0,8.5,4V6.92H3.9a.58.58,0,0,0-.19,0,.5.5,0,0,0-.17.11.91.91,0,0,0-.11.16.63.63,0,0,0,0,.19v3.41a.58.58,0,0,0,0,.19.64.64,0,0,0,.11.16.39.39,0,0,0,.17.11.41.41,0,0,0,.19,0H8.5v2.74a.26.26,0,0,0,.16.26.3.3,0,0,0,.16,0A.34.34,0,0,0,9,14.29l5.42-4.76a.69.69,0,0,0,.16-.22.7.7,0,0,0,0-.52A.69.69,0,0,0,14.39,8.57Z"/>
  </svg>`,
};

function makeReviewBadge(cls) {
  const wrap = document.createElement("span");
  wrap.className = "review-badge cls-" + cls;
  wrap.innerHTML = REVIEW_BADGE_SVG[cls] || "";
  return wrap;
}

// Build an SVG-arrow overlay over the board with one arrow per ply of
// Stockfish's principal variation. Arrows are coloured by which side
// is to move at that ply (white-ish for white, dark for black) and
// fade with depth so the immediate best move is the most contrasty.
// Each arrow gets a small numbered badge at its tail showing the
// ply number across both sides (white = 1, 3, 5… / black = 2, 4, 6…,
// reversed when black is to move first), so the parity of the badge
// number tells the viewer whose move it is.
function renderBoardArrows() {
  const existing = boardEl.querySelector(".board-arrows");
  if (existing) existing.remove();
  const hasBest = !!state.bestArrow;
  const hasPv   = Array.isArray(state.bestPv) && state.bestPv.length > 0;
  if (!hasBest && !hasPv) return;

  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "board-arrows");
  svg.setAttribute("viewBox", "0 0 8 8");
  svg.setAttribute("preserveAspectRatio", "none");

  // Side-of-move palette. White-side arrows are dark slate (so they
  // contrast against the white pieces / light squares), black-side
  // arrows are off-white with a thin dark outline. Per user request:
  // arrow colour visually matches the OPPOSITE side's piece colour
  // (i.e. "opponent's hint"), reversed from the previous default.
  const PALETTE = {
    w: { fill: "30, 32, 38",    outline: "rgba(255, 255, 255, 0.55)" },
    b: { fill: "245, 245, 245", outline: "rgba(15, 18, 25, 0.55)" },
  };

  // Side-to-move at the position currently displayed. PV[0] is played
  // by this side; the colour of arrow `i` is decided by `(stm + i) % 2`.
  const stm = state.sideToMove === "b" ? "b" : "w";
  const count = _clampArrows(userSettings.pvArrowCount);
  const maxPlies = count * 2;

  // All arrows are drawn at the same high contrast — the per-side
  // numbered badge already conveys depth ordering, so fading the
  // colour just made the deeper plies hard to read.
  void count; // count still drives how many arrows are emitted, but
  // no longer modulates alpha.
  function alphaFor(_orderInSide) {
    return 0.92;
  }

  // We need a marker per arrow because the head colour must match the
  // line. Markers are minted on the fly and referenced by id.
  const defs = document.createElementNS(NS, "defs");
  svg.appendChild(defs);
  let markerSeq = 0;
  function mintMarker(colorRgba) {
    const id = `arrow-mk-${markerSeq++}`;
    const m = document.createElementNS(NS, "marker");
    m.setAttribute("id", id);
    m.setAttribute("viewBox", "0 0 10 10");
    m.setAttribute("refX", "7");
    m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "2.6");
    m.setAttribute("markerHeight", "2.6");
    m.setAttribute("orient", "auto");
    const tip = document.createElementNS(NS, "path");
    tip.setAttribute("d", "M0,1.5 L9,5 L0,8.5 L2.5,5 Z");
    tip.setAttribute("fill", colorRgba);
    m.appendChild(tip);
    defs.appendChild(m);
    return id;
  }

  function drawArrow(fromSq, toSq, side, orderInSide, totalIdx, plyNum) {
    const a = squareToBoardXY(fromSq);
    const b = squareToBoardXY(toSq);
    if (!a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) return;
    const pal = PALETTE[side] || PALETTE.w;
    const alpha = alphaFor(orderInSide);
    const fill = `rgba(${pal.fill}, ${alpha.toFixed(3)})`;
    // Slightly thicker outline so the arrow body stays readable on
    // both light and dark squares regardless of side colour.
    const outline = pal.outline;
    const inset = 0.30;
    const x1 = a.x + (dx / len) * 0.18;
    const y1 = a.y + (dy / len) * 0.18;
    const x2 = b.x - (dx / len) * inset;
    const y2 = b.y - (dy / len) * inset;
    // Width tapers slightly with depth so first move looks the boldest.
    const w = 0.13 + (alpha - 0.22) * 0.08;
    const markerId = mintMarker(fill);
    // Outline pass (drawn first, slightly wider) for contrast.
    const outl = document.createElementNS(NS, "line");
    outl.setAttribute("x1", x1);
    outl.setAttribute("y1", y1);
    outl.setAttribute("x2", x2);
    outl.setAttribute("y2", y2);
    outl.setAttribute("stroke", outline);
    outl.setAttribute("stroke-width", String(w + 0.035));
    outl.setAttribute("stroke-linecap", "round");
    svg.appendChild(outl);
    const ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", x1);
    ln.setAttribute("y1", y1);
    ln.setAttribute("x2", x2);
    ln.setAttribute("y2", y2);
    ln.setAttribute("stroke", fill);
    ln.setAttribute("stroke-width", String(w));
    ln.setAttribute("stroke-linecap", "round");
    ln.setAttribute("marker-end", `url(#${markerId})`);
    svg.appendChild(ln);
    // Numbered badge near the source square. Position it ~0.32 units
    // along the arrow so it sits just inside the from-square.
    const bx = a.x + (dx / len) * 0.32;
    const by = a.y + (dy / len) * 0.32;
    const r = 0.22;
    const ring = document.createElementNS(NS, "circle");
    ring.setAttribute("cx", String(bx));
    ring.setAttribute("cy", String(by));
    ring.setAttribute("r", String(r));
    ring.setAttribute("fill", side === "w" ? "#fafafa" : "#1b1d22");
    ring.setAttribute("stroke", side === "w" ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.55)");
    ring.setAttribute("stroke-width", "0.04");
    ring.setAttribute("opacity", String(Math.max(0.55, alpha + 0.05)));
    svg.appendChild(ring);
    const tx = document.createElementNS(NS, "text");
    tx.setAttribute("x", String(bx));
    tx.setAttribute("y", String(by + 0.015));
    tx.setAttribute("text-anchor", "middle");
    tx.setAttribute("dominant-baseline", "central");
    tx.setAttribute("font-size", "0.30");
    tx.setAttribute("font-weight", "700");
    tx.setAttribute("font-family", "system-ui, -apple-system, Segoe UI, Roboto, sans-serif");
    tx.setAttribute("fill", side === "w" ? "#1a1c20" : "#f7f7f9");
    tx.textContent = String(plyNum != null ? plyNum : orderInSide);
    svg.appendChild(tx);
    void totalIdx;  // currently unused, kept for future tooltips/keys.
  }

  if (hasPv) {
    const n = Math.min(state.bestPv.length, maxPlies);
    for (let i = 0; i < n; i++) {
      const m = state.bestPv[i];
      if (!m || m.length < 4) continue;
      const fromSq = m.slice(0, 2);
      const toSq   = m.slice(2, 4);
      const side = ((stm === "w") === (i % 2 === 0)) ? "w" : "b";
      const orderInSide = Math.floor(i / 2) + 1;
      // Sequential ply number across both sides: i=0 is the side-to-move's
      // first ply ("1"), i=1 is the opponent's first ply ("2"), and so on.
      const plyNum = i + 1;
      drawArrow(fromSq, toSq, side, orderInSide, i, plyNum);
    }
  } else if (hasBest) {
    // No PV data (e.g. drill-mode hint): single arrow coloured by stm.
    drawArrow(state.bestArrow.from, state.bestArrow.to, stm, 1, 0, 1);
  }

  boardEl.appendChild(svg);
}

// ---------- FEN serialization ----------

function buildFen() {
  const ranks = [];
  for (let r = 0; r < 8; r++) {
    let row = "";
    let empties = 0;
    for (let f = 0; f < 8; f++) {
      const piece = state.board[r * 8 + f];
      if (piece) {
        if (empties) { row += String(empties); empties = 0; }
        row += piece;
      } else {
        empties++;
      }
    }
    if (empties) row += String(empties);
    ranks.push(row);
  }
  const placement = ranks.join("/");
  let cr = "";
  if (state.castling.K) cr += "K";
  if (state.castling.Q) cr += "Q";
  if (state.castling.k) cr += "k";
  if (state.castling.q) cr += "q";
  if (!cr) cr = "-";
  const ep = state.epSquare && /^[a-h][1-8]$/.test(state.epSquare) ? state.epSquare : "-";
  return `${placement} ${state.sideToMove} ${cr} ${ep} ${state.halfmove} ${state.fullmove}`;
}

function loadFen(fen) {
  const parts = fen.trim().split(/\s+/);
  if (parts.length < 1) throw new Error("Empty FEN");
  const placement = parts[0];
  const ranks = placement.split("/");
  if (ranks.length !== 8) throw new Error("FEN must have 8 ranks");
  const newBoard = new Array(64).fill(null);
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of ranks[r]) {
      if (/[1-8]/.test(ch)) {
        f += parseInt(ch, 10);
      } else if ("KQRBNPkqrbnp".includes(ch)) {
        newBoard[r * 8 + f] = ch;
        f++;
      } else {
        throw new Error(`Invalid character in FEN: ${ch}`);
      }
      if (f > 8) throw new Error("Rank overflow in FEN");
    }
    if (f !== 8) throw new Error("Rank underflow in FEN");
  }
  state.board = newBoard;
  state.sideToMove = parts[1] === "b" ? "b" : "w";
  const cr = parts[2] || "-";
  state.castling = {
    K: cr.includes("K"),
    Q: cr.includes("Q"),
    k: cr.includes("k"),
    q: cr.includes("q"),
  };
  state.epSquare = parts[3] && /^[a-h][1-8]$/.test(parts[3]) ? parts[3] : "-";
  state.halfmove = parseInt(parts[4] || "0", 10) || 0;
  state.fullmove = parseInt(parts[5] || "1", 10) || 1;
  state.selectedSquare = null;
  state.legalTargets = [];
  state.lastMove = null;
  state.reviewBadge = null;
  state.bestArrow = null;
  state.bestPv = null;
}

// ---------- Rendering ----------

const boardEl = document.getElementById("board");
const statusEl = document.getElementById("status-line");

function renderBoard() {
  boardEl.innerHTML = "";
  for (let visualRow = 0; visualRow < 8; visualRow++) {
    for (let visualCol = 0; visualCol < 8; visualCol++) {
      const r = state.flipped ? 7 - visualRow : visualRow;
      const f = state.flipped ? 7 - visualCol : visualCol;
      const idx = r * 8 + f;
      const sqName = squareNameFromIdx(idx);
      const cell = document.createElement("div");
      cell.className = "square " + (((r + f) % 2 === 0) ? "light" : "dark");
      cell.dataset.square = sqName;
      cell.dataset.idx = String(idx);

      // Coordinates are rendered outside the board in dedicated strips
      // (.board-ranks left, .board-files bottom) — see renderBoardCoords().

      const piece = state.board[idx];
      if (piece) {
        const pieceEl = document.createElement("span");
        pieceEl.className = "piece " + (piece === piece.toUpperCase() ? "white" : "black");
        pieceEl.draggable = true;
        pieceEl.dataset.piece = piece;
        pieceEl.dataset.fromSquare = sqName;
        const img = makePieceImg(piece);
        img.draggable = false;
        img.style.pointerEvents = "none";
        pieceEl.appendChild(img);
        cell.appendChild(pieceEl);
      }

      if (state.selectedSquare === sqName) cell.classList.add("selected");
      if (state.legalTargets.includes(sqName)) {
        cell.classList.add(piece ? "legal-capture" : "legal-move");
      }
      if (state.lastMove && (state.lastMove.from === sqName || state.lastMove.to === sqName)) {
        // When we have a classification for the last move, tint
        // *both* squares (origin + destination) with the
        // classification colour, chess.com-style. Without a
        // classification, fall back to the regular yellow highlight.
        if (state.reviewBadge) {
          cell.classList.add("last-move-cls", "cls-" + state.reviewBadge.classification);
        } else {
          cell.classList.add("last-move");
        }
      }

      // Review-mode badges + best-move highlights.
      if (state.reviewBadge && state.reviewBadge.square === sqName) {
        cell.appendChild(makeReviewBadge(state.reviewBadge.classification));
      }
      if (state.bestArrow) {
        if (state.bestArrow.from === sqName) cell.classList.add("best-from");
        if (state.bestArrow.to === sqName) cell.classList.add("best-to");
      }

      attachSquareHandlers(cell);
      boardEl.appendChild(cell);
    }
  }
  renderBoardArrows();
  renderBoardCoords();
  syncMetaInputs();
  document.getElementById("fen-input").value = buildFen();
  // After every full board re-render, push the current selection (or
  // its absence) to spectators so their hint dots / source-square
  // overlay stay in sync with what the player sees. The helper is a
  // no-op outside an active party and dedupes against the last
  // payload, so it's cheap to call here.
  if (typeof _partySyncSelectionFromState === "function") {
    _partySyncSelectionFromState();
  }
}

// Render rank numbers (left strip) and file letters (bottom strip)
// outside the board, respecting flip state. The strips are sized via
// CSS grid so cells/letters always align with the board cells.
function renderBoardCoords() {
  const ranks = document.getElementById("board-ranks");
  const files = document.getElementById("board-files");
  if (!ranks || !files) return;
  const rankOrder = state.flipped
    ? ["1", "2", "3", "4", "5", "6", "7", "8"]
    : ["8", "7", "6", "5", "4", "3", "2", "1"];
  const fileOrder = state.flipped
    ? ["h", "g", "f", "e", "d", "c", "b", "a"]
    : ["a", "b", "c", "d", "e", "f", "g", "h"];
  ranks.innerHTML = rankOrder.map((r) => `<span>${r}</span>`).join("");
  files.innerHTML = fileOrder.map((f) => `<span>${f}</span>`).join("");
}

function syncMetaInputs() {
  document.getElementById("side-to-move").value = state.sideToMove;
  const turnSel = document.getElementById("turn-select");
  if (turnSel) turnSel.value = state.sideToMove;
  if (typeof refreshUndoRedoButtons === "function") refreshUndoRedoButtons();
  document.getElementById("cr-K").checked = state.castling.K;
  document.getElementById("cr-Q").checked = state.castling.Q;
  document.getElementById("cr-k").checked = state.castling.k;
  document.getElementById("cr-q").checked = state.castling.q;
  document.getElementById("ep-square").value = state.epSquare === "-" ? "" : state.epSquare;
  document.getElementById("halfmove").value = String(state.halfmove);
  document.getElementById("fullmove").value = String(state.fullmove);
}

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status " + kind;
}

// ---------- Drag-drop ----------

// HTML5 drag-and-drop is desktop-only — touchstart never fires
// dragstart on phones. To make the board playable on mobile we run a
// parallel touch-drag layer at document level (one listener, no
// per-piece bookkeeping). Tap-to-select-tap-to-move still works via
// the .square click handler; this is purely the drag affordance.
const _touchDrag = {
  active: false,
  source: null,        // the .piece DOM element being dragged
  fromSquare: null,    // algebraic source square
  piece: null,         // FEN char of the piece
  startX: 0,
  startY: 0,
  ghost: null,         // floating piece image following the finger
  threshold: 8,        // px before we commit to a drag
  primed: false,       // touch is down on a piece, waiting for movement
};

function _touchEnsureGhost(srcImg, x, y) {
  if (_touchDrag.ghost) return _touchDrag.ghost;
  const g = document.createElement("img");
  g.src = srcImg ? srcImg.src : "";
  g.alt = "";
  g.className = "touch-drag-ghost";
  g.style.position = "fixed";
  g.style.left = "0";
  g.style.top = "0";
  g.style.width = "56px";
  g.style.height = "56px";
  g.style.pointerEvents = "none";
  g.style.zIndex = "9999";
  g.style.transform = `translate(${(x - 28).toFixed(1)}px, ${(y - 28).toFixed(1)}px) scale(1.05)`;
  g.style.filter = "drop-shadow(0 4px 8px rgba(0,0,0,0.5))";
  document.body.appendChild(g);
  _touchDrag.ghost = g;
  return g;
}

function _touchClearDrag() {
  if (_touchDrag.source) _touchDrag.source.classList.remove("dragging");
  if (_touchDrag.ghost) {
    try { _touchDrag.ghost.remove(); } catch (_) { /* ignore */ }
  }
  document.querySelectorAll(".square.drop-target")
    .forEach((c) => c.classList.remove("drop-target"));
  clearDragLegalTargets();
  _touchDrag.active = false;
  _touchDrag.primed = false;
  _touchDrag.source = null;
  _touchDrag.fromSquare = null;
  _touchDrag.piece = null;
  _touchDrag.ghost = null;
}

document.addEventListener("touchstart", (ev) => {
  // Only react to a single finger on a board piece. Multi-touch
  // (pinch-zoom etc.) is left to the browser.
  if (ev.touches.length !== 1) return;
  const t = ev.touches[0];
  const pieceEl = t.target.closest && t.target.closest(".piece");
  if (!pieceEl) return;
  // Skip palette pieces — they have draggable=true but no fromSquare;
  // we don't support placing pieces from the palette via touch (rare
  // use case + tap-to-select doesn't have an obvious target). Users
  // can still drag from the palette on a desktop.
  const cell = pieceEl.closest(".square");
  if (!cell || !cell.dataset.square) return;
  _touchDrag.primed = true;
  _touchDrag.source = pieceEl;
  _touchDrag.fromSquare = cell.dataset.square;
  _touchDrag.piece = pieceEl.dataset.piece || "";
  _touchDrag.startX = t.clientX;
  _touchDrag.startY = t.clientY;
}, { passive: true });

document.addEventListener("touchmove", (ev) => {
  if (!_touchDrag.primed && !_touchDrag.active) return;
  if (ev.touches.length !== 1) { _touchClearDrag(); return; }
  const t = ev.touches[0];
  if (!_touchDrag.active) {
    // Promote primed -> active once the user has moved past the
    // threshold. Below it we leave the touch alone so tap-to-select
    // still bubbles into the cell click handler.
    const dx = t.clientX - _touchDrag.startX;
    const dy = t.clientY - _touchDrag.startY;
    if ((dx * dx + dy * dy) < _touchDrag.threshold * _touchDrag.threshold) return;
    _touchDrag.active = true;
    if (_touchDrag.source) _touchDrag.source.classList.add("dragging");
    paintDragLegalTargets(_touchDrag.fromSquare);
    const srcImg = _touchDrag.source && _touchDrag.source.querySelector("img");
    _touchEnsureGhost(srcImg, t.clientX, t.clientY);
  }
  // Now in active drag — block scroll and follow finger.
  if (ev.cancelable) ev.preventDefault();
  if (_touchDrag.ghost) {
    _touchDrag.ghost.style.transform = `translate(${(t.clientX - 28).toFixed(1)}px, ${(t.clientY - 28).toFixed(1)}px) scale(1.05)`;
  }
  // Highlight the cell currently under the finger.
  const under = document.elementFromPoint(t.clientX, t.clientY);
  const overCell = under && under.closest && under.closest(".square");
  document.querySelectorAll(".square.drop-target")
    .forEach((c) => { if (c !== overCell) c.classList.remove("drop-target"); });
  if (overCell) overCell.classList.add("drop-target");
}, { passive: false });

document.addEventListener("touchend", (ev) => {
  if (!_touchDrag.active) {
    // Touch ended without moving past threshold — let it become a
    // click; just reset bookkeeping.
    _touchClearDrag();
    return;
  }
  const t = (ev.changedTouches && ev.changedTouches[0]) || null;
  if (!t) { _touchClearDrag(); return; }
  // Briefly hide the ghost so elementFromPoint doesn't pick *it* up.
  if (_touchDrag.ghost) _touchDrag.ghost.style.display = "none";
  const under = document.elementFromPoint(t.clientX, t.clientY);
  const dropCell = under && under.closest && under.closest(".square");
  const fromSquare = _touchDrag.fromSquare;
  const piece = _touchDrag.piece;
  _touchClearDrag();
  if (!dropCell || !dropCell.dataset.square) return;
  const targetSquare = dropCell.dataset.square;
  if (targetSquare === fromSquare) return;
  // Mirror handleDrop's branching: game / legal-mode / sandbox.
  if (state.game.active) {
    if (!fromSquare) return;
    tryMakePlayerMove(fromSquare, targetSquare);
    return;
  }
  if (state.legalMode) {
    if (!fromSquare) return;
    tryFreeplayMove(fromSquare, targetSquare);
    return;
  }
  if (!fromSquare) return;
  const fromIdx = idxFromSquareName(fromSquare);
  const targetIdx = idxFromSquareName(targetSquare);
  if (fromIdx === targetIdx) return;
  snapshotForUndo();
  state.board[targetIdx] = piece || state.board[fromIdx];
  state.board[fromIdx] = null;
  state.lastMove = null;
  state.selectedSquare = null;
  state.legalTargets = [];
  renderBoard();
}, { passive: true });

document.addEventListener("touchcancel", () => _touchClearDrag(), { passive: true });

function attachSquareHandlers(cell) {
  cell.addEventListener("dragover", (e) => {
    e.preventDefault();
    cell.classList.add("drop-target");
  });
  cell.addEventListener("dragleave", () => cell.classList.remove("drop-target"));
  cell.addEventListener("drop", (e) => {
    e.preventDefault();
    cell.classList.remove("drop-target");
    handleDrop(e, cell);
  });
  cell.addEventListener("click", () => handleSquareClick(cell.dataset.square));

  const pieceEl = cell.querySelector(".piece");
  if (pieceEl) {
    pieceEl.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData(
        "application/x-chess-piece",
        JSON.stringify({
          piece: pieceEl.dataset.piece,
          fromSquare: pieceEl.dataset.fromSquare,
        })
      );
      e.dataTransfer.effectAllowed = "move";
      pieceEl.classList.add("dragging");
      // Light up legal targets for the piece being dragged so the
      // user sees where it can land. We MUST NOT call renderBoard()
      // here \u2014 rebuilding the DOM mid-dragstart destroys the source
      // element and the browser cancels the drag. Instead we paint
      // the classes directly on the existing cells.
      const fromSq = pieceEl.dataset.fromSquare;
      if (fromSq) paintDragLegalTargets(fromSq);
    });
    pieceEl.addEventListener("dragend", () => {
      pieceEl.classList.remove("dragging");
      // Clear paint-only highlights without touching state.legalTargets
      // (those are owned by the click-select flow).
      clearDragLegalTargets();
    });
  }
}

function handleDrop(e, cell) {
  const targetSquare = cell.dataset.square;
  const raw = e.dataTransfer.getData("application/x-chess-piece");
  if (!raw) return;
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }

  if (state.game.active) {
    // In-game: only legal moves allowed and only for the player's pieces.
    if (!payload.fromSquare) {
      setStatus("В режиме игры нельзя ставить фигуры с палитры.", "error");
      return;
    }
    tryMakePlayerMove(payload.fromSquare, targetSquare);
    return;
  }

  if (state.legalMode) {
    if (!payload.fromSquare) {
      setStatus("В легальном режиме нельзя ставить фигуры с палитры. Переключитесь в Песочницу.", "error");
      return;
    }
    tryFreeplayMove(payload.fromSquare, targetSquare);
    return;
  }

  const targetIdx = idxFromSquareName(targetSquare);
  if (payload.fromSquare) {
    const fromIdx = idxFromSquareName(payload.fromSquare);
    if (fromIdx === targetIdx) return;
    snapshotForUndo();
    state.board[targetIdx] = state.board[fromIdx];
    state.board[fromIdx] = null;
  } else {
    snapshotForUndo();
    state.board[targetIdx] = payload.piece;
  }
  state.lastMove = null;
  state.selectedSquare = null;
  state.legalTargets = [];
  renderBoard();
}

function tryFreeplayMove(from, to) {
  // Drill / Puzzle modes hijack freeplay drops: instead of mutating
  // the sandbox we treat the drop as the user's "answer".
  if (state.drill.active) {
    tryDrillMove(from, to);
    return;
  }
  if (state.puzzle && state.puzzle.active && state.view === "puzzle") {
    tryPuzzleMove(from, to);
    return;
  }
  if (state.daily && state.daily.active && state.view === "daily") {
    tryDailyMove(from, to);
    return;
  }
  if (state.rush && state.rush.active && state.view === "rush") {
    tryRushMove(from, to);
    return;
  }
  if (state.opening && state.opening.active && state.view === "opening") {
    tryOpeningMove(from, to);
    return;
  }
  const c = ensureFreeplayChess();
  if (!c) return;
  const moveTo = freeplayCastlingTarget(c, from, to) || to;
  let move;
  try {
    move = c.move({ from, to: moveTo, promotion: "q" });
  } catch {
    move = null;
  }
  if (!move) {
    setStatus("Нелегальный ход.", "error");
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
    // Note: no illegal sound in freeplay sandbox — the spec says illegal
    // is only when you try a forbidden move while playing vs Stockfish.
    return;
  }
  snapshotForUndo();
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  state.selectedSquare = null;
  state.legalTargets = [];
  renderBoard();
  setStatus(`Ход: ${move.san}.`);
  // Freeplay: the user controls both sides, treat every move as "own".
  playMoveSoundFor(move, { isOwn: true, inCheck: c.isCheck() });
}

function ensureFreeplayChess() {
  try {
    state.freeplay.chess = new Chess(buildFen());
    return state.freeplay.chess;
  } catch (err) {
    setStatus("Позиция нелегальна для легального режима: " + err.message, "error");
    return null;
  }
}

function freeplayCastlingTarget(c, from, to) {
  const fromPiece = c.get(from);
  const toPiece = c.get(to);
  if (!fromPiece || !toPiece) return null;
  if (fromPiece.type !== "k") return null;
  if (toPiece.type !== "r" || toPiece.color !== fromPiece.color) return null;
  const rank = fromPiece.color === "w" ? "1" : "8";
  if (from !== "e" + rank) return null;
  if (to === "h" + rank) return "g" + rank;
  if (to === "a" + rank) return "c" + rank;
  return null;
}

function handleSquareClick(squareName) {
  const idx = idxFromSquareName(squareName);
  if (state.eraseMode && !state.game.active && !state.legalMode) {
    if (state.board[idx]) {
      snapshotForUndo();
      state.board[idx] = null;
      renderBoard();
    }
    return;
  }
  if (state.game.active) {
    handleGameSquareClick(squareName);
    return;
  }
  if (state.legalMode) {
    handleFreeplaySquareClick(squareName);
  }
}

function handleFreeplaySquareClick(squareName) {
  const c = ensureFreeplayChess();
  if (!c) return;
  const piece = c.get(squareName);
  if (state.selectedSquare) {
    if (state.selectedSquare === squareName) {
      state.selectedSquare = null;
      state.legalTargets = [];
      renderBoard();
      return;
    }
    if (state.legalTargets.includes(squareName) || freeplayCastlingTarget(c, state.selectedSquare, squareName)) {
      tryFreeplayMove(state.selectedSquare, squareName);
      return;
    }
    if (piece && piece.color === c.turn()) {
      selectFreeplaySquare(squareName);
      return;
    }
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
    return;
  }
  if (piece && piece.color === c.turn()) {
    selectFreeplaySquare(squareName);
  }
}

// Drag&drop helper: paint legal-move/legal-capture classes on the
// existing cell DOM nodes WITHOUT re-rendering the board (which would
// destroy the dragstart source element and cancel the drag). Returns
// the list of squares that were painted so the caller can pass it to
// clearDragLegalTargets() if it wants \u2014 we also remember the painted
// list in module state so dragend can find it after the DOM may have
// been re-rendered for an unrelated reason.
const _dragHighlightedSquares = new Set();

function _legalTargetsForSquare(squareName) {
  // Returns either { ok: true, chess, targets: [..] } describing legal
  // landings for the piece on `squareName`, or { ok: false } if there
  // are no legal targets to highlight (wrong colour, sandbox, etc.).
  let c = null;
  if (state.game.active) {
    c = state.game.chess;
    if (c.turn() !== state.game.playerColor) return { ok: false };
  } else if (state.legalMode) {
    c = ensureFreeplayChess();
  } else {
    // Sandbox: any piece can go anywhere \u2014 no highlight to compute.
    return { ok: false };
  }
  if (!c) return { ok: false };
  const piece = c.get(squareName);
  if (!piece || piece.color !== c.turn()) return { ok: false };
  const moves = c.moves({ square: squareName, verbose: true });
  const targets = moves.map((m) => m.to);
  // Mirror selectSquare/selectFreeplaySquare: also accept king-on-rook
  // drag-targets for castling so the highlight reflects what the drop
  // handler will actually accept.
  for (const m of moves) {
    if (m.flags && (m.flags.includes("k") || m.flags.includes("q"))) {
      const rank = m.color === "w" ? "1" : "8";
      const rookSq = m.flags.includes("k") ? "h" + rank : "a" + rank;
      if (!targets.includes(rookSq)) targets.push(rookSq);
    }
  }
  return { ok: true, chess: c, targets };
}

function paintDragLegalTargets(squareName) {
  clearDragLegalTargets();
  const r = _legalTargetsForSquare(squareName);
  if (!r.ok) return;
  const boardEl = document.getElementById("board");
  if (!boardEl) return;
  // Mark the source square as 'selected' so the user gets the same
  // visual cue as click-to-select.
  const fromCell = boardEl.querySelector(`.square[data-square="${squareName}"]`);
  if (fromCell) {
    fromCell.classList.add("selected");
    _dragHighlightedSquares.add(squareName);
  }
  const captures = [];
  for (const sq of r.targets) {
    const cell = boardEl.querySelector(`.square[data-square="${sq}"]`);
    if (!cell) continue;
    const piece = r.chess.get(sq);
    cell.classList.add(piece ? "legal-capture" : "legal-move");
    if (piece) captures.push(sq);
    _dragHighlightedSquares.add(sq);
  }
  // Drag bypasses renderBoard() (rebuilding the DOM mid-drag would
  // cancel the drag), so we still need to push the same hint info to
  // spectators directly here.
  if (typeof _liveIsActive === "function" && _liveIsActive()) {
    let pieceTag = null;
    try {
      const p = r.chess.get(squareName);
      if (p) pieceTag = (p.color || "w") + (p.type || "p").toUpperCase();
    } catch (_) { /* ignore */ }
    const key = `${squareName}|${r.targets.join(",")}|${pieceTag}|${captures.join(",")}`;
    if (window.__partyLastSelectionSent !== key) {
      window.__partyLastSelectionSent = key;
      _partyReportSelection({
        from: squareName,
        piece: pieceTag,
        legalMoves: r.targets,
        legalCaptures: captures,
      });
    }
  }
}

function clearDragLegalTargets() {
  if (_dragHighlightedSquares.size === 0) return;
  const boardEl = document.getElementById("board");
  if (!boardEl) { _dragHighlightedSquares.clear(); return; }
  for (const sq of _dragHighlightedSquares) {
    const cell = boardEl.querySelector(`.square[data-square="${sq}"]`);
    if (!cell) continue;
    cell.classList.remove("legal-move", "legal-capture", "selected");
  }
  _dragHighlightedSquares.clear();
  if (typeof _liveIsActive === "function" && _liveIsActive()
      && window.__partyLastSelectionSent !== null) {
    window.__partyLastSelectionSent = null;
    _partyReportSelection({ from: null, piece: null, legalMoves: [], legalCaptures: [] });
  }
}

function selectFreeplaySquare(squareName) {
  const c = state.freeplay.chess;
  state.selectedSquare = squareName;
  const moves = c.moves({ square: squareName, verbose: true });
  const targets = moves.map((m) => m.to);
  for (const m of moves) {
    if (m.flags && (m.flags.includes("k") || m.flags.includes("q"))) {
      const rank = m.color === "w" ? "1" : "8";
      const rookSq = m.flags.includes("k") ? "h" + rank : "a" + rank;
      if (!targets.includes(rookSq)) targets.push(rookSq);
    }
  }
  state.legalTargets = targets;
  renderBoard();
}

// ---------- Palette ----------

function renderPalette() {
  const whiteRow = document.getElementById("palette-white");
  const blackRow = document.getElementById("palette-black");
  whiteRow.innerHTML = "";
  blackRow.innerHTML = "";
  for (const p of PIECE_TYPES_WHITE) {
    whiteRow.appendChild(makePaletteCell(p));
  }
  for (const p of PIECE_TYPES_BLACK) {
    blackRow.appendChild(makePaletteCell(p));
  }
}

function makePaletteCell(piece) {
  const div = document.createElement("div");
  div.className = "palette-cell piece " + (piece === piece.toUpperCase() ? "white" : "black");
  const img = makePieceImg(piece);
  img.draggable = false;
  img.style.pointerEvents = "none";
  div.appendChild(img);
  div.draggable = true;
  div.dataset.piece = piece;
  div.title = piece;
  div.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData(
      "application/x-chess-piece",
      JSON.stringify({ piece: piece, fromSquare: null })
    );
    e.dataTransfer.effectAllowed = "copy";
  });
  return div;
}

// ---------- Toolbar ----------

// Settings modal: board theme + piece set with localStorage persistence.
function openSettingsModal() {
  const modal = document.getElementById("settings-modal");
  const themesEl = document.getElementById("settings-themes");
  const piecesEl = document.getElementById("settings-pieces");
  if (!modal || !themesEl || !piecesEl) return;
  themesEl.innerHTML = Object.entries(BOARD_THEMES).map(([key, t]) => {
    const previewStyle = t.image
      ? `background-image:url("${t.image}");background-size:cover;background-position:center;`
      : `background:linear-gradient(135deg, ${t.light} 0 50%, ${t.dark} 50% 100%);`;
    return `
    <button type="button" class="theme-swatch ${userSettings.theme === key ? "is-active" : ""}" data-theme="${key}" title="${t.name}">
      <span class="theme-swatch-preview" style="${previewStyle}"></span>
      <span class="theme-swatch-label">${t.name}</span>
    </button>
  `;
  }).join("");
  piecesEl.innerHTML = Object.entries(PIECE_SETS).map(([key, p]) => {
    const ext = p.ext || "svg";
    return `
    <button type="button" class="piece-swatch ${userSettings.pieces === key ? "is-active" : ""}" data-pieces="${key}" title="${p.name}">
      <img src="/static/pieces/${key}/wK.${ext}" alt="" />
      <img src="/static/pieces/${key}/bN.${ext}" alt="" />
      <span class="piece-swatch-label">${p.name}</span>
    </button>
  `;
  }).join("");
  themesEl.querySelectorAll("[data-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      userSettings.theme = btn.dataset.theme;
      saveSettings(userSettings);
      applyBoardTheme();
      themesEl.querySelectorAll(".is-active").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
    });
  });
  piecesEl.querySelectorAll("[data-pieces]").forEach((btn) => {
    btn.addEventListener("click", () => {
      userSettings.pieces = btn.dataset.pieces;
      saveSettings(userSettings);
      renderBoard();        // re-render to swap piece SVGs
      renderPalette();      // palette uses piece images too
      piecesEl.querySelectorAll(".is-active").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
    });
  });
  const pvInput = document.getElementById("settings-pv-arrows");
  if (pvInput) {
    pvInput.value = String(_clampArrows(userSettings.pvArrowCount));
    const apply = () => {
      const next = _clampArrows(pvInput.value);
      pvInput.value = String(next);
      if (next !== userSettings.pvArrowCount) {
        userSettings.pvArrowCount = next;
        saveSettings(userSettings);
        renderBoard();   // re-draw arrows with the new cap
      }
    };
    pvInput.addEventListener("change", apply);
    pvInput.addEventListener("blur", apply);
  }
  const blInput = document.getElementById("settings-best-line");
  if (blInput) {
    blInput.value = String(_clampBestLine(userSettings.bestLineLength));
    const apply = () => {
      const next = _clampBestLine(blInput.value);
      blInput.value = String(next);
      if (next !== userSettings.bestLineLength) {
        userSettings.bestLineLength = next;
        saveSettings(userSettings);
        // Re-render the active position's hint so the SAN line updates.
        if (typeof renderBoardHint === "function") renderBoardHint();
      }
    };
    blInput.addEventListener("change", apply);
    blInput.addEventListener("blur", apply);
  }
  const dotInput = document.getElementById("settings-legal-dot");
  const dotReset = document.getElementById("settings-legal-dot-reset");
  if (dotInput) {
    dotInput.value = _isHexColor(userSettings.legalDotColor)
      ? userSettings.legalDotColor
      : DEFAULT_LEGAL_DOT_COLOR;
    const apply = () => {
      const v = dotInput.value;
      if (!_isHexColor(v)) return;
      userSettings.legalDotColor = v;
      saveSettings(userSettings);
      applyLegalDotColor();
    };
    dotInput.addEventListener("input", apply);
    dotInput.addEventListener("change", apply);
  }
  if (dotReset) {
    dotReset.addEventListener("click", () => {
      userSettings.legalDotColor = DEFAULT_LEGAL_DOT_COLOR;
      saveSettings(userSettings);
      applyLegalDotColor();
      if (dotInput) dotInput.value = DEFAULT_LEGAL_DOT_COLOR;
    });
  }
  const sizeInput = document.getElementById("settings-piece-size");
  const sizeNum = document.getElementById("settings-piece-size-num");
  const offsetInput = document.getElementById("settings-piece-offset");
  const offsetNum = document.getElementById("settings-piece-offset-num");
  const pieceReset = document.getElementById("settings-piece-reset");
  function syncSizeUi(v) {
    if (sizeInput) sizeInput.value = String(v);
    if (sizeNum) sizeNum.value = String(v);
  }
  function syncOffsetUi(v) {
    if (offsetInput) offsetInput.value = String(v);
    if (offsetNum) offsetNum.value = String(v);
  }
  syncSizeUi(_clampPieceSize(userSettings.pieceSize));
  syncOffsetUi(_clampPieceOffsetY(userSettings.pieceOffsetY));
  function applySize(raw) {
    const next = _clampPieceSize(raw);
    syncSizeUi(next);
    if (next !== userSettings.pieceSize) {
      userSettings.pieceSize = next;
      saveSettings(userSettings);
      applyPieceSizing();
    }
  }
  function applyOffset(raw) {
    const next = _clampPieceOffsetY(raw);
    syncOffsetUi(next);
    if (next !== userSettings.pieceOffsetY) {
      userSettings.pieceOffsetY = next;
      saveSettings(userSettings);
      applyPieceSizing();
    }
  }
  if (sizeInput) sizeInput.addEventListener("input", () => applySize(sizeInput.value));
  if (sizeNum) {
    sizeNum.addEventListener("input", () => applySize(sizeNum.value));
    sizeNum.addEventListener("change", () => applySize(sizeNum.value));
  }
  if (offsetInput) offsetInput.addEventListener("input", () => applyOffset(offsetInput.value));
  if (offsetNum) {
    offsetNum.addEventListener("input", () => applyOffset(offsetNum.value));
    offsetNum.addEventListener("change", () => applyOffset(offsetNum.value));
  }
  if (pieceReset) {
    pieceReset.addEventListener("click", () => {
      userSettings.pieceSize = DEFAULT_PIECE_SIZE;
      userSettings.pieceOffsetY = DEFAULT_PIECE_OFFSET_Y;
      saveSettings(userSettings);
      syncSizeUi(DEFAULT_PIECE_SIZE);
      syncOffsetUi(DEFAULT_PIECE_OFFSET_Y);
      applyPieceSizing();
    });
  }
  modal.hidden = false;
}
function closeSettingsModal() {
  const modal = document.getElementById("settings-modal");
  if (modal) modal.hidden = true;
}
document.getElementById("btn-settings")?.addEventListener("click", openSettingsModal);
document.getElementById("btn-settings-close")?.addEventListener("click", closeSettingsModal);
document.getElementById("settings-modal")?.addEventListener("click", (e) => {
  if (e.target.id === "settings-modal") closeSettingsModal();
});
document.getElementById("btn-sound")?.addEventListener("click", () => {
  userSettings.soundOn = !userSettings.soundOn;
  saveSettings(userSettings);
  refreshSoundButton();
  // Demo a tap when turning on so the user immediately hears the volume.
  if (userSettings.soundOn) playMoveSound();
});
refreshSoundButton();

document.getElementById("btn-flip").addEventListener("click", () => {
  state.flipped = !state.flipped;
  renderBoard();
  renderPlayerStrips();
  refreshEvalBarFromActive();
});
document.getElementById("btn-phys-flip").addEventListener("click", () => {
  if (state.game.active) {
    setStatus("Сначала остановите партию против движка.", "error");
    return;
  }
  snapshotForUndo();
  loadFen(physicallyFlippedFen(buildFen()));
  state.lastMove = null;
  renderBoard();
  setStatus("Позиция физически перевёрнута.");
});
document.getElementById("btn-reset").addEventListener("click", () => {
  if (state.game.active) stopGame();
  snapshotForUndo();
  loadFen(STARTPOS_FEN);
  renderBoard();
  setStatus("Стартовая позиция загружена.");
});
document.getElementById("btn-clear").addEventListener("click", () => {
  if (state.game.active) stopGame();
  snapshotForUndo();
  loadFen(EMPTY_FEN);
  renderBoard();
  setStatus("Доска очищена.");
});

function physicallyFlippedFen(fen) {
  const parts = fen.split(/\s+/);
  const placement = parts[0];
  const ranks = placement.split("/");
  const flipped = ranks.slice().reverse().map((r) => {
    const chars = [];
    for (const ch of r) {
      if (/\d/.test(ch)) for (let i = 0; i < parseInt(ch, 10); i++) chars.push("1");
      else chars.push(ch);
    }
    chars.reverse();
    let out = "";
    let run = 0;
    for (const ch of chars) {
      if (ch === "1") { run++; }
      else { if (run) { out += String(run); run = 0; } out += ch; }
    }
    if (run) out += String(run);
    return out;
  });
  parts[0] = flipped.join("/");
  return parts.join(" ");
}
document.getElementById("erase-mode").addEventListener("change", (e) => {
  state.eraseMode = e.target.checked;
});

// Meta inputs
document.getElementById("side-to-move").addEventListener("change", (e) => {
  snapshotForUndo();
  state.sideToMove = e.target.value;
  const turnSel = document.getElementById("turn-select");
  if (turnSel) turnSel.value = state.sideToMove;
  renderBoard();
});
document.getElementById("turn-select").addEventListener("change", (e) => {
  snapshotForUndo();
  state.sideToMove = e.target.value;
  document.getElementById("side-to-move").value = state.sideToMove;
  renderBoard();
});
for (const k of ["K", "Q", "k", "q"]) {
  document.getElementById("cr-" + k).addEventListener("change", (e) => {
    state.castling[k] = e.target.checked;
    renderBoard();
  });
}
document.getElementById("ep-square").addEventListener("change", (e) => {
  const v = e.target.value.trim();
  state.epSquare = /^[a-h][1-8]$/.test(v) ? v : "-";
  renderBoard();
});
document.getElementById("halfmove").addEventListener("change", (e) => {
  state.halfmove = parseInt(e.target.value || "0", 10) || 0;
  renderBoard();
});
document.getElementById("fullmove").addEventListener("change", (e) => {
  state.fullmove = parseInt(e.target.value || "1", 10) || 1;
  renderBoard();
});

document.getElementById("btn-load-fen").addEventListener("click", () => {
  const v = document.getElementById("fen-input").value;
  try {
    snapshotForUndo();
    loadFen(v);
    renderBoard();
    setStatus("FEN загружен.", "ok");
  } catch (err) {
    setStatus("Ошибка FEN: " + err.message, "error");
  }
});

// ---------- Undo / Redo ----------

const MAX_HISTORY = 200;

function snapshotForUndo() {
  if (state.game.active) return;
  try {
    const fen = buildFen();
    const last = state.history[state.history.length - 1];
    if (last === fen) return;
    state.history.push(fen);
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.redoStack.length = 0;
    refreshUndoRedoButtons();
  } catch { /* ignore */ }
}

function refreshUndoRedoButtons() {
  const u = document.getElementById("btn-undo");
  const r = document.getElementById("btn-redo");
  if (u) u.disabled = state.history.length === 0 || state.game.active;
  if (r) r.disabled = state.redoStack.length === 0 || state.game.active;
}

function doUndo() {
  if (state.game.active) return;
  if (!state.history.length) return;
  const current = buildFen();
  const prev = state.history.pop();
  state.redoStack.push(current);
  if (state.redoStack.length > MAX_HISTORY) state.redoStack.shift();
  applyFenFromHistory(prev);
  setStatus("Отменено.");
}

function doRedo() {
  if (state.game.active) return;
  if (!state.redoStack.length) return;
  const current = buildFen();
  const next = state.redoStack.pop();
  state.history.push(current);
  if (state.history.length > MAX_HISTORY) state.history.shift();
  applyFenFromHistory(next);
  setStatus("Повторено.");
}

function applyFenFromHistory(fen) {
  try {
    loadFen(fen);
    state.lastMove = null;
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
  } catch (err) {
    setStatus("Не удалось применить FEN из истории: " + err.message, "error");
  }
  refreshUndoRedoButtons();
}

document.getElementById("btn-undo").addEventListener("click", doUndo);
document.getElementById("btn-redo").addEventListener("click", doRedo);

document.addEventListener("keydown", (e) => {
  const tag = e.target && e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) return;
  if (!(e.ctrlKey || e.metaKey)) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); doUndo(); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); doRedo(); }
});
document.getElementById("btn-copy-fen").addEventListener("click", async () => {
  const fen = buildFen();
  try {
    await navigator.clipboard.writeText(fen);
    setStatus("FEN скопирован в буфер.", "ok");
  } catch {
    setStatus("Не удалось скопировать. FEN: " + fen);
  }
});

// ---------- Engine / API ----------

async function api(path, options = {}) {
  const resp = await fetch(path, options);
  if (!resp.ok) {
    let msg = resp.statusText;
    try {
      const j = await resp.json();
      if (j && j.detail) msg = j.detail;
    } catch { /* ignore */ }
    throw new Error(msg);
  }
  return resp.json();
}

async function refreshEngineStatus() {
  try {
    const h = await api("/api/health");
    state.engine.running = !!h.engine.running;
    state.engine.path = h.engine.path;
    document.getElementById("engine-status").textContent = state.engine.running
      ? `работает: ${state.engine.path}`
      : "не настроен";
    document.getElementById("engine-status").className = state.engine.running ? "ok" : "muted";
    if (h.engine.configured_path && !document.getElementById("engine-path").value) {
      document.getElementById("engine-path").value = h.engine.configured_path;
    } else if (h.engine.resolved_path && !document.getElementById("engine-path").value) {
      document.getElementById("engine-path").value = h.engine.resolved_path;
    }
  } catch (err) {
    document.getElementById("engine-status").textContent = "ошибка: " + err.message;
  }
}

function intOrDefault(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

document.getElementById("btn-engine-configure").addEventListener("click", async () => {
  const body = {
    path: document.getElementById("engine-path").value || null,
    threads: intOrDefault(document.getElementById("engine-threads").value, 2),
    hash_mb: intOrDefault(document.getElementById("engine-hash").value, 256),
    skill_level: intOrDefault(document.getElementById("engine-skill").value, 20),
  };
  setStatus("Запускаю Stockfish…");
  try {
    const r = await api("/api/engine/configure", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setStatus("Движок запущен: " + (r.engine.id?.name || "Stockfish"), "ok");
    await refreshEngineStatus();
  } catch (err) {
    setStatus("Не удалось запустить Stockfish: " + err.message, "error");
  }
});

document.getElementById("btn-engine-stop").addEventListener("click", async () => {
  try {
    await api("/api/engine/stop", { method: "POST" });
    setStatus("Движок остановлен.");
    await refreshEngineStatus();
  } catch (err) {
    setStatus("Ошибка: " + err.message, "error");
  }
});

document.getElementById("btn-engine-think").addEventListener("click", async () => {
  const fen = buildFen();
  const movetime = parseInt(document.getElementById("movetime").value, 10) || 1000;
  setStatus("Stockfish думает…");
  try {
    const r = await api("/api/engine/best_move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, movetime_ms: movetime }),
    });
    const evalText = formatEval(r);
    setStatus(`Подсказка: ${r.best_move} ${evalText}`, "ok");
    if (r.best_move) {
      const from = r.best_move.slice(0, 2);
      const to = r.best_move.slice(2, 4);
      state.lastMove = { from, to };
      renderBoard();
    }
  } catch (err) {
    setStatus("Stockfish: " + err.message, "error");
  }
});

function formatEval(r) {
  if (r.score_mate !== null && r.score_mate !== undefined) return `(мат в ${r.score_mate})`;
  if (r.score_cp !== null && r.score_cp !== undefined) {
    const v = (r.score_cp / 100).toFixed(2);
    const sign = r.score_cp > 0 ? "+" : "";
    return `(${sign}${v})`;
  }
  return "";
}

// ---------- Play vs Stockfish ----------

document.getElementById("btn-play-start").addEventListener("click", async () => {
  if (state.game.active) {
    setStatus("Игра уже идёт. Сначала остановите.", "error");
    return;
  }
  const fen = buildFen();
  let chess;
  try {
    chess = new Chess(fen);
  } catch (err) {
    setStatus("Позиция нелегальна для игры: " + err.message, "error");
    return;
  }
  if (!state.engine.running) {
    setStatus("Сначала запустите движок.", "error");
    return;
  }
  state.game = {
    active: true,
    chess,
    playerColor: document.getElementById("player-color").value,
    movetimeMs: parseInt(document.getElementById("movetime").value, 10) || 1000,
    history: [],
    stopRequested: false,
  };
  document.getElementById("btn-play-stop").disabled = false;
  document.getElementById("btn-play-start").disabled = true;
  document.getElementById("play-status").textContent = "Игра началась.";
  renderHistory();
  if (chess.turn() !== state.game.playerColor) {
    await engineMove();
  } else {
    document.getElementById("play-status").textContent = "Ваш ход.";
  }
});

document.getElementById("btn-play-stop").addEventListener("click", () => stopGame());

function stopGame() {
  state.game.stopRequested = true;
  state.game.active = false;
  document.getElementById("btn-play-stop").disabled = true;
  document.getElementById("btn-play-start").disabled = false;
  document.getElementById("play-status").textContent = "Игра остановлена.";
}

function renderHistory() {
  const ol = document.getElementById("move-history");
  ol.innerHTML = "";
  const moves = state.game.history;
  for (let i = 0; i < moves.length; i += 2) {
    const li = document.createElement("li");
    const w = moves[i] || "";
    const b = moves[i + 1] || "";
    li.textContent = `${w}${b ? "  " + b : ""}`;
    ol.appendChild(li);
  }
}

async function engineMove() {
  if (!state.game.active) return;
  // Capture the game object at request time so a stop+restart during
  // the await can't make us apply a stale move to the new game.
  const myGame = state.game;
  const fen = myGame.chess.fen();
  document.getElementById("play-status").textContent = "Stockfish думает…";
  try {
    const r = await api("/api/engine/best_move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fen, movetime_ms: myGame.movetimeMs }),
    });
    if (myGame !== state.game || myGame.stopRequested) return;
    if (!r.best_move) {
      setStatus("Stockfish не вернул ход.", "error");
      stopGame();
      return;
    }
    const from = r.best_move.slice(0, 2);
    const to = r.best_move.slice(2, 4);
    const promo = r.best_move.length > 4 ? r.best_move[4] : undefined;
    const move = myGame.chess.move({ from, to, promotion: promo || "q" });
    if (!move) {
      setStatus("Движок предложил нелегальный ход: " + r.best_move, "error");
      stopGame();
      return;
    }
    applyChessMoveToBoard(move);
    // Engine-side move: opponent perspective unless the user picked the
    // engine's colour (rare but possible mid-game flip).
    playMoveSoundFor(move, {
      isOwn: move.color === myGame.playerColor,
      inCheck: myGame.chess.isCheck(),
    });
    document.getElementById("play-status").textContent =
      `Ход движка: ${move.san} ${formatEval(r)}. ${gameStateText()}`;
    if (checkGameOver()) return;
    if (myGame.chess.turn() === myGame.playerColor) {
      document.getElementById("play-status").textContent += " Ваш ход.";
    }
  } catch (err) {
    if (myGame !== state.game) return;
    setStatus("Stockfish: " + err.message, "error");
    stopGame();
  }
}

function applyChessMoveToBoard(move) {
  // Replace the entire board state with the chess.js position so that
  // castling rook moves, en-passant captures, and promotions all render
  // correctly.
  loadFen(state.game.chess.fen());
  state.lastMove = { from: move.from, to: move.to };
  state.game.history.push(move.san);
  renderBoard();
  renderHistory();
}

function gameStateText() {
  const c = state.game.chess;
  if (c.isCheckmate()) return "Мат!";
  if (c.isStalemate()) return "Пат.";
  if (c.isDraw()) return "Ничья.";
  if (c.isCheck()) return "Шах.";
  return "";
}

function checkGameOver() {
  const c = state.game.chess;
  if (c.isGameOver()) {
    document.getElementById("play-status").textContent = "Партия окончена. " + gameStateText();
    state.game.active = false;
    document.getElementById("btn-play-stop").disabled = true;
    document.getElementById("btn-play-start").disabled = false;
    return true;
  }
  return false;
}

function handleGameSquareClick(squareName) {
  const c = state.game.chess;
  if (c.turn() !== state.game.playerColor) return;
  const piece = c.get(squareName);
  if (state.selectedSquare) {
    if (state.selectedSquare === squareName) {
      state.selectedSquare = null;
      state.legalTargets = [];
      renderBoard();
      return;
    }
    if (state.legalTargets.includes(squareName)) {
      tryMakePlayerMove(state.selectedSquare, squareName);
      return;
    }
    if (castlingTargetIfKingOnRook(state.selectedSquare, squareName)) {
      tryMakePlayerMove(state.selectedSquare, squareName);
      return;
    }
    if (piece && piece.color === state.game.playerColor) {
      selectSquare(squareName);
      return;
    }
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
    return;
  }
  if (piece && piece.color === state.game.playerColor) {
    selectSquare(squareName);
  }
}

function selectSquare(squareName) {
  state.selectedSquare = squareName;
  const moves = state.game.chess.moves({ square: squareName, verbose: true });
  const targets = moves.map((m) => m.to);
  // Also let the user drop the king onto the rook to castle.
  for (const m of moves) {
    if (m.flags && (m.flags.includes("k") || m.flags.includes("q"))) {
      const rank = m.color === "w" ? "1" : "8";
      const rookSq = m.flags.includes("k") ? "h" + rank : "a" + rank;
      if (!targets.includes(rookSq)) targets.push(rookSq);
    }
  }
  state.legalTargets = targets;
  renderBoard();
}

function tryMakePlayerMove(from, to) {
  if (!state.game.active) return;
  const c = state.game.chess;
  if (c.turn() !== state.game.playerColor) return;
  const moveTo = castlingTargetIfKingOnRook(from, to) || to;
  let move;
  try {
    move = c.move({ from, to: moveTo, promotion: "q" });
  } catch {
    move = null;
  }
  if (!move) {
    setStatus("Нелегальный ход.", "error");
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
    // Per spec: illegal sound fires only when the user tries to play an
    // illegal move while playing vs Stockfish.
    playIllegalSound();
    return;
  }
  state.selectedSquare = null;
  state.legalTargets = [];
  applyChessMoveToBoard(move);
  // Player move sound: always "own".
  playMoveSoundFor(move, { isOwn: true, inCheck: c.isCheck() });
  if (checkGameOver()) return;
  setTimeout(engineMove, 50);
}

function castlingTargetIfKingOnRook(from, to) {
  const c = state.game.chess;
  const fromPiece = c.get(from);
  const toPiece = c.get(to);
  if (!fromPiece || !toPiece) return null;
  if (fromPiece.type !== "k") return null;
  if (toPiece.type !== "r" || toPiece.color !== fromPiece.color) return null;
  const rank = fromPiece.color === "w" ? "1" : "8";
  if (from !== "e" + rank) return null;
  if (to === "h" + rank) return "g" + rank;  // short
  if (to === "a" + rank) return "c" + rank;  // long
  return null;
}

// ---------- Recognize ----------

async function recognizeFile(file, { autoApply = false } = {}) {
  const out = document.getElementById("recognize-output");
  if (!file) {
    setStatus("Нет изображения для распознавания.", "error");
    return;
  }
  if (!file.type || !file.type.startsWith("image/")) {
    setStatus("Это не изображение: " + (file.type || "unknown"), "error");
    return;
  }
  out.textContent = "Распознаю…";
  const fd = new FormData();
  fd.append("image", file, file.name || "clipboard.png");
  try {
    const resp = await fetch("/api/recognize", { method: "POST", body: fd });
    const j = await resp.json();
    if (!resp.ok) throw new Error(j.detail || resp.statusText);
    const fen = j.fen;
    out.innerHTML = "";
    const top = document.createElement("div");
    top.textContent = `Метод: ${j.method}, уверенность: ${(j.confidence * 100).toFixed(0)}%`;
    out.appendChild(top);
    const fenRow = document.createElement("div");
    fenRow.className = "recognize-fen";
    const inp = document.createElement("input");
    inp.type = "text"; inp.value = fen; inp.spellcheck = false;
    inp.style.fontFamily = "ui-monospace, monospace";
    const btn = document.createElement("button");
    btn.textContent = "Применить к доске";
    btn.addEventListener("click", () => {
      try {
        loadFen(inp.value);
        renderBoard();
        setStatus("Позиция применена.", "ok");
      } catch (err) {
        setStatus("Ошибка FEN: " + err.message, "error");
      }
    });
    fenRow.appendChild(inp);
    fenRow.appendChild(btn);
    out.appendChild(fenRow);
    if (j.notes && j.notes.length) {
      const ul = document.createElement("ul");
      ul.style.margin = "6px 0 0 18px"; ul.style.padding = "0";
      for (const n of j.notes) {
        const li = document.createElement("li");
        li.textContent = n;
        li.style.fontSize = "12px";
        li.style.color = "var(--fg-muted)";
        ul.appendChild(li);
      }
      out.appendChild(ul);
    }
    if (autoApply) {
      try {
        loadFen(fen);
        renderBoard();
        setStatus(`Позиция применена (распознано, ${(j.confidence * 100).toFixed(0)}%).`, "ok");
      } catch (err) {
        setStatus("Распознано, но FEN не применён: " + err.message, "error");
      }
    }
  } catch (err) {
    out.textContent = "Ошибка: " + err.message;
  }
}

document.getElementById("btn-recognize").addEventListener("click", () => {
  const f = document.getElementById("recognize-file").files[0];
  if (!f) {
    setStatus("Выберите файл изображения.", "error");
    return;
  }
  recognizeFile(f);
});

document.getElementById("recognize-file").addEventListener("change", (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) recognizeFile(f);
});

function imageFileFromDataTransfer(dt) {
  if (!dt) return null;
  if (dt.files && dt.files.length) {
    for (const f of dt.files) {
      if (f.type && f.type.startsWith("image/")) return f;
    }
  }
  if (dt.items && dt.items.length) {
    for (const it of dt.items) {
      if (it.kind === "file") {
        const f = it.getAsFile();
        if (f && f.type && f.type.startsWith("image/")) return f;
      }
    }
  }
  return null;
}

function handlePasteEvent(e) {
  const target = e.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
    return;
  }
  const f = imageFileFromDataTransfer(e.clipboardData);
  if (!f) return;
  e.preventDefault();
  recognizeFile(f, { autoApply: true });
}
document.addEventListener("paste", handlePasteEvent);

async function pasteFromClipboardAPI() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    setStatus("Браузер не поддерживает чтение буфера. Используй Ctrl+V напрямую.", "error");
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      for (const t of item.types) {
        if (t.startsWith("image/")) {
          const blob = await item.getType(t);
          const file = new File([blob], "clipboard.png", { type: t });
          await recognizeFile(file, { autoApply: true });
          return;
        }
      }
    }
    setStatus("В буфере нет изображения.", "error");
  } catch (err) {
    setStatus("Не удалось прочитать буфер: " + err.message, "error");
  }
}

const pasteBtn = document.getElementById("btn-paste-clipboard");
if (pasteBtn) {
  pasteBtn.addEventListener("click", pasteFromClipboardAPI);
}

const dropzone = document.getElementById("recognize-dropzone");
if (dropzone) {
  for (const evt of ["dragenter", "dragover"]) {
    dropzone.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      dropzone.classList.add("is-active");
    });
  }
  for (const evt of ["dragleave", "dragend"]) {
    dropzone.addEventListener(evt, () => dropzone.classList.remove("is-active"));
  }
  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropzone.classList.remove("is-active");
    const f = imageFileFromDataTransfer(e.dataTransfer);
    if (f) recognizeFile(f, { autoApply: true });
    else setStatus("В буфере / на drop'е нет изображения.", "error");
  });
  dropzone.addEventListener("paste", (e) => {
    const f = imageFileFromDataTransfer(e.clipboardData);
    if (!f) return;
    e.preventDefault();
    recognizeFile(f, { autoApply: true });
  });
}

// ---------- View tabs (Main / Analysis) ----------

function setView(view) {
  const allowed = ["main", "analysis", "puzzle", "daily", "rush", "battle", "opening"];
  const v = allowed.includes(view) ? view : "main";
  const prev = state.view;
  state.view = v;
  for (const k of allowed) {
    document.body.classList.toggle(`view-${k}`, v === k);
  }
  document.querySelectorAll(".view-tab").forEach((btn) => {
    const isActive = btn.dataset.view === v;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  try { localStorage.setItem("cs.view", v); } catch (_) { /* ignore */ }
  // Each "puzzle-like" view owns the board while it's active; entering
  // and leaving the view is the natural place to load / unload it.
  if (prev === "puzzle" && v !== "puzzle" && state.puzzle && state.puzzle.current) {
    leavePuzzleView();
  }
  if (prev === "rush" && v !== "rush") leaveRushView();
  if (prev === "daily" && v !== "daily") leaveDailyView();
  if (prev === "opening" && v !== "opening") leaveOpeningView();
  if (prev === "battle" && v !== "battle") leaveBattleView();
  if (v === "puzzle")       enterPuzzleView();
  else if (v === "daily")   enterDailyView();
  else if (v === "rush")    enterRushView();
  else if (v === "battle")  enterBattleView();
  else if (v === "opening") enterOpeningView();
}

document.querySelectorAll(".view-tab").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

setView((() => {
  try { return localStorage.getItem("cs.view") || "main"; } catch (_) { return "main"; }
})());

// ---------- Mode switch ----------

function setBoardMode(legal) {
  state.legalMode = !!legal;
  state.selectedSquare = null;
  state.legalTargets = [];
  document.body.classList.toggle("mode-legal", state.legalMode);
  document.body.classList.toggle("mode-sandbox", !state.legalMode);
  document.getElementById("btn-mode-legal").classList.toggle("is-active", state.legalMode);
  document.getElementById("btn-mode-sandbox").classList.toggle("is-active", !state.legalMode);
  if (state.legalMode) {
    state.eraseMode = false;
    const eraseEl = document.getElementById("erase-mode");
    if (eraseEl) eraseEl.checked = false;
    ensureFreeplayChess();
  }
  renderBoard();
}

document.getElementById("btn-mode-legal").addEventListener("click", () => {
  if (state.game.active) {
    setStatus("Сначала остановите партию против движка.", "error");
    return;
  }
  setBoardMode(true);
  setStatus("Режим: легальный — только ходы по правилам.");
});
document.getElementById("btn-mode-sandbox").addEventListener("click", () => {
  if (state.game.active) {
    setStatus("Сначала остановите партию против движка.", "error");
    return;
  }
  setBoardMode(false);
  setStatus("Режим: песочница — фигуры можно ставить и двигать как угодно.");
});

// ---------- Game review (chess.com-style) ----------

const REVIEW_ICONS = {
  brilliant: "!!", great: "!", best: "★", excellent: "✓",
  good: "✓", book: "📖", forced: "⛓",
  inaccuracy: "?!", mistake: "?", blunder: "??", miss: "✗",
};
const REVIEW_LABELS = {
  brilliant: "Бриллиант", great: "Великолепный", best: "Лучший",
  excellent: "Превосходный", good: "Хороший", book: "Теория",
  forced: "Вынужденный",
  inaccuracy: "Неточность", mistake: "Ошибка",
  blunder: "Грубая ошибка", miss: "Упущенная победа",
};

const REVIEW_ORDER = [
  "brilliant","great","best","excellent","good","book","forced",
  "inaccuracy","mistake","miss","blunder",
];

const REVIEW_COLOR = {
  brilliant: "#26c2a3",
  great:     "#749bbf",
  best:      "#81b64c",
  excellent: "#81b64c",
  good:      "#95b776",
  book:      "#d5a47d",
  forced:    "#96af8b",
  inaccuracy:"#f7c631",
  mistake:   "#ffa459",
  blunder:   "#fa412d",
  miss:      "#ff7769",
};

const review = {
  game: null,
  analysis: null,
  activeIdx: -1,
  filter: new Set(),  // active classification filters; empty == show all
  userSide: null,     // "w" | "b" | null — which side the user played
  sideAsked: false,   // have we already shown the side-pick modal this session
  clocks: [],         // per-ply remaining-time in seconds, parallel to moves_uci
  autoplayId: null,   // setInterval id when auto-stepping next moves
  // AI coach (Ollama + Stockfish 18) for the Game-Review board hint.
  // Replaces the old hardcoded `💡 coach` blurb with a streamed,
  // chess.com-style explanation of why the move got its classification.
  aiCoach: {
    status: null,            // null | "checking" | true | false
    model: "",
    baseUrl: "",
    installedModels: [],
    stockfishRunning: false,
    streaming: false,
    text: "",
    error: "",
    cache: {},               // { [ply]: rendered text } — avoid re-streaming on revisit
    activeReqPly: -1,        // ply currently being streamed (cancel guard for stale renders)
  },
};

// Classifications worth burning a coach call on. Anything else (best,
// good, book, forced) is uncontroversial and the local hint suffices.
const REVIEW_AI_WORTHY = new Set([
  "brilliant", "great",
  "inaccuracy", "mistake", "blunder", "miss",
]);

function fmtCp(cp) {
  if (cp >= 99000) {
    const n = 100000 - cp;
    return n === 0 ? "#" : `#${n}`;
  }
  if (cp <= -99000) {
    const n = cp + 100000;
    return n === 0 ? "−#" : `−#${n}`;
  }
  const v = (cp / 100).toFixed(2);
  return cp > 0 ? `+${v}` : v;
}

// Strip query/fragment/sub-paths from chess.com / lichess game URLs so users can
// paste any flavour (live, analysis, ?username=…&move=…) and get the canonical
// game link the importer expects.
function normalizeReviewSource(raw) {
  const src = (raw || "").trim();
  if (!src) return src;
  let url;
  try { url = new URL(src); } catch { return src; }
  const host = url.hostname.toLowerCase();
  if (host.endsWith("chess.com")) {
    const m = url.pathname.match(/\/game\/(live|daily|rapid|bullet|blitz)\/(\d+)/i)
      || url.pathname.match(/\/(live|daily|rapid|bullet|blitz)\/(\d+)/i);
    if (m) {
      const kind = m[1].toLowerCase();
      const id = m[2];
      return `https://www.chess.com/game/${kind}/${id}`;
    }
    return src;
  }
  if (host.endsWith("lichess.org")) {
    const m = url.pathname.match(/^\/(?:embed\/)?([a-zA-Z0-9]{8})/);
    if (m) return `https://lichess.org/${m[1]}`;
    return src;
  }
  return src;
}

(function wireReviewSourceAutoNormalize() {
  const input = document.getElementById("review-source");
  if (!input) return;
  const normalize = () => {
    const v = input.value;
    const n = normalizeReviewSource(v);
    if (n && n !== v) input.value = n;
  };
  input.addEventListener("paste", () => setTimeout(normalize, 0));
  input.addEventListener("change", normalize);
  input.addEventListener("blur", normalize);
})();

document.getElementById("btn-review-import").addEventListener("click", async () => {
  const input = document.getElementById("review-source");
  const normalized = normalizeReviewSource(input.value);
  if (normalized !== input.value) input.value = normalized;
  const src = normalized.trim();
  if (!src) { setStatus("Вставьте ссылку или PGN.", "error"); return; }
  document.getElementById("btn-review-import").disabled = true;
  document.getElementById("review-progress").textContent = "Загрузка партии…";
  try {
    const r = await api("/api/game/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: src }),
    });
    review.game = r;
    review.analysis = null;
    review.clocks = parsePgnClocks(r.pgn || "");
    // Reset side-pick state every time a new game is loaded so we always
    // ask which colour the user played for *this* game (don't reuse the
    // previous game's answer).
    review.userSide = null;
    review.sideAsked = false;
    review.filter.clear();
    review.activeIdx = -1;
    document.getElementById("review-progress").textContent =
      `${r.headers.White || "?"} vs ${r.headers.Black || "?"} — ${r.moves_uci.length} полуходов. Спрашиваем…`;
    document.getElementById("btn-review-analyse").disabled = false;
    renderPlayerStrips();
    renderReviewMoves();
    document.getElementById("review-summary").innerHTML = "";
    // Ask immediately so the analysis is correctly oriented and labelled
    // before the user even clicks «Анализировать».
    review.sideAsked = true;
    const picked = await askUserSide();
    review.userSide = picked || null;
    if (picked === "b" && !state.flipped) state.flipped = true;
    if (picked === "w" && state.flipped) state.flipped = false;
    renderBoard();
    renderPlayerStrips();
    document.getElementById("review-progress").textContent =
      `${r.headers.White || "?"} vs ${r.headers.Black || "?"} — ${r.moves_uci.length} полуходов. Жми «Анализировать».`;
  } catch (err) {
    document.getElementById("review-progress").textContent = "Ошибка: " + err.message;
  } finally {
    document.getElementById("btn-review-import").disabled = false;
  }
});

function askUserSide() {
  return new Promise((resolve) => {
    const modal = document.getElementById("side-modal");
    if (!modal) { resolve(null); return; }
    modal.hidden = false;
    const onClick = (ev) => {
      const btn = ev.target.closest("[data-side]");
      if (!btn) return;
      modal.hidden = true;
      modal.removeEventListener("click", onClick);
      resolve(btn.dataset.side || null);
    };
    modal.addEventListener("click", onClick);
  });
}

document.getElementById("btn-review-analyse").addEventListener("click", async () => {
  if (!review.game) return;
  if (!review.sideAsked) {
    review.sideAsked = true;
    const picked = await askUserSide();
    review.userSide = picked || null;
    // Auto-orient board for the user's side (white = a1 bottom-left).
    if (picked === "b" && !state.flipped) state.flipped = true;
    if (picked === "w" && state.flipped) state.flipped = false;
    renderBoard();
    renderPlayerStrips();
  }
  const depthRaw = document.getElementById("review-depth").value.trim();
  const movetimeRaw = document.getElementById("review-movetime").value.trim();
  const depth = depthRaw ? Math.max(6, Math.min(40, parseInt(depthRaw, 10) || 8)) : 8;
  const movetime = movetimeRaw ? Math.max(50, Math.min(60000, parseInt(movetimeRaw, 10) || 0)) : null;
  const total = review.game.moves_uci.length;
  document.getElementById("btn-review-analyse").disabled = true;
  document.getElementById("review-progress").textContent = movetime
    ? `Анализ… ~${Math.ceil(total * movetime * 2 / 1000)} сек`
    : `Анализ на глубину ${depth}…`;
  try {
    const r = await api("/api/game/analyse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moves_uci: review.game.moves_uci,
        starting_fen: review.game.starting_fen,
        depth: movetime ? null : depth,
        movetime_ms: movetime,
        multipv: 3,
      }),
    });
    review.analysis = r;
    renderReviewSummary(r.summary);
    renderRatingPanel(r.summary);
    renderPhasesPanel(r.summary);
    renderEvalGraph(r.moves);
    renderKeyMoments(r.key_moments || []);
    renderReviewMoves();
    revealEvalBar();
    updateEvalBar(0, "w");  // reset to neutral until user navigates
    document.getElementById("review-progress").textContent =
      `Готово — ${r.moves.length} ходов проанализировано.`;
  } catch (err) {
    document.getElementById("review-progress").textContent = "Ошибка анализа: " + err.message;
  } finally {
    document.getElementById("btn-review-analyse").disabled = false;
  }
});

// Chess.com glyph for the "Game Review" header.
const GAME_REVIEW_GLYPH = `<svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" viewBox="0 0 24 24" width="22" height="22"><path d="M12 22.5C6.2 22.5 1.5 17.8 1.5 12C1.5 6.2 6.2 1.5 12 1.5C17.8 1.5 22.5 6.2 22.5 12C22.5 17.8 17.8 22.5 12 22.5ZM7.37 17.87C7.17 18.67 7.44 18.87 8.14 18.4L12.01 15.67L15.84 18.4C16.54 18.87 16.81 18.67 16.61 17.87L15.44 13.27L18.91 10.57C19.58 10.04 19.48 9.7 18.64 9.64L14.11 9.31L12.48 5.18C12.18 4.41 11.81 4.41 11.51 5.18L9.98 9.31L5.35 9.64C4.52 9.71 4.42 10.04 5.08 10.54L8.58 13.27L7.37 17.87Z"/></svg>`;

function _avatarFor(side, headers) {
  if (!headers) return null;
  const key = side === "w" ? "WhiteAvatar" : "BlackAvatar";
  return headers[key] || null;
}

function _nameFor(side, headers) {
  if (!headers) return side === "w" ? "Белые" : "Чёрные";
  const k = side === "w" ? "White" : "Black";
  const name = headers[k] || (side === "w" ? "Белые" : "Чёрные");
  const eloKey = side === "w" ? "WhiteElo" : "BlackElo";
  const elo = headers[eloKey];
  return elo ? `${name} (${elo})` : name;
}

function _placeholderAvatar(side) {
  // Chess.com-style empty pawn placeholder (no external request).
  const fill = side === "w" ? "#f4f5f6" : "#262421";
  const stroke = side === "w" ? "#9b9b9b" : "#000";
  const piece = side === "w" ? "#e3e3e3" : "#3a3936";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36" width="100%" height="100%">
    <rect width="36" height="36" rx="4" fill="${fill}" stroke="${stroke}" stroke-width="1"/>
    <path fill="${piece}" d="M18 8a3.2 3.2 0 0 0-3 4.5c-1.4.6-2.4 2-2.4 3.6 0 1.5.8 2.8 2 3.5L13 27h10l-1.6-7.4c1.2-.7 2-2 2-3.5 0-1.6-1-3-2.4-3.6A3.2 3.2 0 0 0 18 8Z"/>
  </svg>`;
}

function renderReviewSummary(s) {
  const counts = s.counts || {};
  const root = document.getElementById("review-summary");
  const hdr = (review.game && review.game.headers) || {};
  const wAvatar = _avatarFor("w", hdr);
  const bAvatar = _avatarFor("b", hdr);
  const wName = _nameFor("w", hdr);
  const bName = _nameFor("b", hdr);
  const userSide = review.userSide;
  const sideClass = (col) =>
    `gr-cell gr-side-${col}${userSide === col ? " is-you" : ""}`;
  const avatarCell = (col, url) => `<div class="${sideClass(col)} gr-avatar-cell">
      <div class="gr-avatar" data-side="${col}">${url ? `<img src="${url}" alt="" referrerpolicy="no-referrer" />` : _placeholderAvatar(col)}</div>
    </div>`;
  const accCell = (col, info) => `<div class="${sideClass(col)} gr-acc-cell">
      <div class="gr-acc-pill gr-acc-${col}">${info.accuracy}%</div>
      <div class="gr-acc-sub">ACPL ${info.acpl}</div>
    </div>`;

  // Build per-classification rows with clickable filter behaviour.
  // The filter set stores per-side keys: `${cls}:w` and `${cls}:b`.
  // Clicking the white-count cell toggles only the white side; the
  // black-count cell toggles only the black side; the centre icon
  // toggles both at once. Empty filter == "show all".
  const rowsHtml = REVIEW_ORDER.map((k) => {
    const n = counts[k] || 0;
    // Backend doesn't currently split counts per side; we derive it by
    // walking `review.analysis.moves` if present.
    let nW = 0;
    let nB = 0;
    if (review.analysis && Array.isArray(review.analysis.moves)) {
      for (const mv of review.analysis.moves) {
        if (mv.classification !== k) continue;
        if (mv.side === "w") nW += 1;
        else nB += 1;
      }
    } else {
      nW = n;
      nB = 0;
    }
    const wActive = review.filter.has(`${k}:w`);
    const bActive = review.filter.has(`${k}:b`);
    const bothActive = wActive && bActive;
    const anyActive = wActive || bActive;
    const isOff = n === 0;
    const color = REVIEW_COLOR[k];
    return `<div class="gr-row gr-row-cls cls-${k}${isOff ? " is-off" : ""}${anyActive ? " is-active" : ""}" data-cls="${k}" style="--cls-color:${color}">
      <div class="gr-cell gr-label">${REVIEW_LABELS[k]}</div>
      <div class="gr-cell gr-side-w gr-count gr-side-pick${wActive ? " is-active" : ""}" data-cls="${k}" data-side="w" style="color:${color}">${nW}</div>
      <div class="gr-cell gr-icon gr-side-pick${bothActive ? " is-active" : ""}" data-cls="${k}" data-side="both">${REVIEW_BADGE_SVG[k] || ""}</div>
      <div class="gr-cell gr-side-b gr-count gr-side-pick${bActive ? " is-active" : ""}" data-cls="${k}" data-side="b" style="color:${color}">${nB}</div>
    </div>`;
  }).join("");

  root.innerHTML = `
    <div class="gr-header">
      <span class="gr-glyph">${GAME_REVIEW_GLYPH}</span>
      <span class="gr-title">Game Review</span>
      <span class="gr-filter-hint muted" id="review-filter-hint"></span>
    </div>
    <div id="gr-graph-slot" class="gr-graph-slot"></div>
    <div class="gr-grid">
      <div class="gr-row gr-row-names">
        <div class="gr-cell gr-label">&nbsp;</div>
        <div class="${sideClass("w")} gr-name">${wName}</div>
        <div class="gr-cell"></div>
        <div class="${sideClass("b")} gr-name">${bName}</div>
      </div>
      <div class="gr-row gr-row-players">
        <div class="gr-cell gr-label">Players</div>
        ${avatarCell("w", wAvatar)}
        <div class="gr-cell"></div>
        ${avatarCell("b", bAvatar)}
      </div>
      <div class="gr-row gr-row-accuracy">
        <div class="gr-cell gr-label">Accuracy</div>
        ${accCell("w", s.white)}
        <div class="gr-cell"></div>
        ${accCell("b", s.black)}
      </div>
      <div class="gr-divider"></div>
      ${rowsHtml}
    </div>
  `;

  // Wire avatar error → fallback to placeholder SVG.
  root.querySelectorAll(".gr-avatar img").forEach((img) => {
    img.addEventListener("error", () => {
      const wrap = img.parentElement;
      if (!wrap) return;
      const side = wrap.dataset.side === "b" ? "b" : "w";
      wrap.innerHTML = _placeholderAvatar(side);
    });
  });

  // Wire per-side click → filter toggle. Each row has 3 click zones:
  // white-count, icon (both sides), black-count. The icon toggles
  // the row as a whole (both sides at once).
  root.querySelectorAll(".gr-side-pick").forEach((cell) => {
    cell.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const row = cell.closest(".gr-row-cls");
      if (row && row.classList.contains("is-off")) return;
      const k = cell.dataset.cls;
      const side = cell.dataset.side;
      const wKey = `${k}:w`;
      const bKey = `${k}:b`;
      if (side === "w") {
        if (review.filter.has(wKey)) review.filter.delete(wKey);
        else review.filter.add(wKey);
      } else if (side === "b") {
        if (review.filter.has(bKey)) review.filter.delete(bKey);
        else review.filter.add(bKey);
      } else {
        // both — if either is on, clear both; otherwise add both.
        if (review.filter.has(wKey) || review.filter.has(bKey)) {
          review.filter.delete(wKey);
          review.filter.delete(bKey);
        } else {
          review.filter.add(wKey);
          review.filter.add(bKey);
        }
      }
      renderReviewSummary(s);
      renderReviewMoves();
    });
  });

  const hint = document.getElementById("review-filter-hint");
  if (hint) {
    hint.textContent = review.filter.size > 0
      ? `(фильтр: ${review.filter.size})`
      : "";
  }

  // Move the eval-graph DOM node into the Game Review slot so it lives
  // above the player names row (chess.com Game Review layout).
  const slot = document.getElementById("gr-graph-slot");
  const graph = document.getElementById("review-graph-wrap");
  if (slot && graph && graph.parentElement !== slot) {
    slot.appendChild(graph);
  }
}

function renderRatingPanel(summary) {
  const host = document.getElementById("review-rating");
  if (!host) return;
  const userSide = review.userSide;
  const card = (color, info) => {
    const r = info.estimated_rating;
    const valueHtml = r != null
      ? `<div class="rating-value">${r}</div>`
      : `<div class="rating-value is-na">—</div>`;
    const isYou = userSide === color ? " is-you" : "";
    const label = color === "w" ? "Белые" : "Чёрные";
    return `<div class="rating-card${isYou}">
      <span class="rating-disc ${color}"></span>
      <div>
        <div class="rating-label">Game Rating · ${label}${userSide === color ? " (вы)" : ""}</div>
        ${valueHtml}
      </div>
    </div>`;
  };
  host.innerHTML = card("w", summary.white) + card("b", summary.black);
}

function renderPhasesPanel(summary) {
  const host = document.getElementById("review-phases");
  if (!host) return;
  const phases = [
    ["opening", "Opening Accuracy"],
    ["middlegame", "Middlegame Accuracy"],
    ["endgame", "Endgame Accuracy"],
  ];
  const fmt = (v) => v == null ? `<span class="phase-acc is-na">—</span>` : `<span class="phase-acc">${v}%</span>`;
  host.innerHTML = phases.map(([key, title]) => {
    const w = summary.white.phases?.[key] || {};
    const b = summary.black.phases?.[key] || {};
    return `<div class="phase-card">
      <div class="phase-title">${title}</div>
      <div class="phase-row"><span><span class="phase-disc w"></span>Белые</span> ${fmt(w.accuracy)}</div>
      <div class="phase-row"><span><span class="phase-disc b"></span>Чёрные</span> ${fmt(b.accuracy)}</div>
    </div>`;
  }).join("");
}

// ---------- Eval bar ----------

function revealEvalBar() {
  const bar = document.getElementById("eval-bar");
  if (bar) bar.hidden = false;
}
function hideEvalBar() {
  const bar = document.getElementById("eval-bar");
  if (bar) bar.hidden = true;
}

// Map cp (white POV) to a 0..1 fraction of board-height occupied by white.
function cpToWhiteFrac(cpWhitePov) {
  if (cpWhitePov >= 99000) return 1.0;
  if (cpWhitePov <= -99000) return 0.0;
  // Same logistic curve as backend (Lichess WP formula); centred at 0 = 50%.
  const wp = 0.5 + 0.5 * (2.0 / (1.0 + Math.exp(-0.00368208 * cpWhitePov)) - 1.0);
  return Math.max(0.02, Math.min(0.98, wp));
}

function updateEvalBar(cpWhitePov, _moverSide) {
  const bar = document.getElementById("eval-bar");
  const label = document.getElementById("eval-bar-label");
  if (!bar || !label) return;
  const frac = cpToWhiteFrac(cpWhitePov);
  // The white block always represents white's share of the bar and the
  // black block always represents black's share. To make the bar match
  // the board orientation when it is flipped, the eval-bar element itself
  // uses flex-direction: column-reverse via the .flipped class, swapping
  // their visual order without inverting the meaning of the values.
  const flipped = state.flipped;
  const whiteBottom = !flipped;
  bar.classList.toggle("flipped", flipped);
  bar.style.setProperty("--eval-white", `${(frac * 100).toFixed(2)}%`);
  bar.style.setProperty("--eval-black", `${((1 - frac) * 100).toFixed(2)}%`);
  // Pretty number.
  let text;
  if (cpWhitePov >= 99000)      text = `M${100000 - cpWhitePov}`;
  else if (cpWhitePov <= -99000) text = `M${cpWhitePov + 100000}`;
  else text = (Math.abs(cpWhitePov) / 100).toFixed(1);
  label.textContent = text;
  // Label sits on the side of whoever has the advantage.
  const whiteAdvantage = cpWhitePov >= 0;
  const labelOnTop = (whiteBottom && !whiteAdvantage) || (!whiteBottom && whiteAdvantage);
  if (labelOnTop) {
    bar.style.setProperty("--eval-label-top", "4px");
    bar.style.setProperty("--eval-label-bottom", "auto");
  } else {
    bar.style.setProperty("--eval-label-top", "auto");
    bar.style.setProperty("--eval-label-bottom", "4px");
  }
  if (whiteAdvantage) {
    bar.style.setProperty("--eval-label-bg", "#f1f2f2");
    bar.style.setProperty("--eval-label-fg", "#0d121d");
  } else {
    bar.style.setProperty("--eval-label-bg", "#232629");
    bar.style.setProperty("--eval-label-fg", "#f1f2f2");
  }
}

// Called whenever activeIdx changes (jumpToReviewIdx) to keep the
// eval bar in sync with the current position.
function refreshEvalBarFromActive() {
  const moves = review.analysis ? review.analysis.moves : null;
  if (!moves) { return; }
  const idx = review.activeIdx;
  let cp = 0;
  let mover = "w";
  if (idx >= 0) {
    const m = moves[idx];
    // m.eval_after_cp is from mover POV; convert to white POV.
    cp = m.side === "w" ? m.eval_after_cp : -m.eval_after_cp;
    mover = m.side;
  } else {
    // Starting position — use first move's eval_before_cp from white POV.
    const m0 = moves[0];
    if (m0) cp = m0.side === "w" ? m0.eval_before_cp : -m0.eval_before_cp;
  }
  updateEvalBar(cp, mover);
}

// ---------- Eval graph (chess.com Highcharts style) ----------

const GRAPH_DOT_RADIUS = 2.6;
const GRAPH_W = 600;  // SVG viewBox width
const GRAPH_H = 100;

// Build a smoothed cubic-Bezier path through the given (x,y) points
// (Catmull-Rom → Bezier conversion, tension = 0.5).
function _smoothPath(points) {
  if (points.length === 0) return "";
  if (points.length === 1) return `M${points[0][0]},${points[0][1]}`;
  const segs = [`M${points[0][0].toFixed(2)},${points[0][1].toFixed(2)}`];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    segs.push(
      `C${cp1x.toFixed(2)},${cp1y.toFixed(2)} ` +
      `${cp2x.toFixed(2)},${cp2y.toFixed(2)} ` +
      `${p2[0].toFixed(2)},${p2[1].toFixed(2)}`
    );
  }
  return segs.join(" ");
}

function renderEvalGraph(moves) {
  const wrap = document.getElementById("review-graph-wrap");
  const svg = document.getElementById("review-graph");
  const tip = document.getElementById("review-graph-tip");
  if (!wrap || !svg || !tip || !moves || moves.length === 0) {
    if (wrap) wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  svg.setAttribute("viewBox", `0 0 ${GRAPH_W} ${GRAPH_H}`);
  const n = moves.length;
  // Per-ply white-POV cp, prepended with the starting eval (=0 from white's
  // POV in the standard position).
  const cps = [0].concat(
    moves.map((m) => (m.side === "w" ? m.eval_after_cp : -m.eval_after_cp))
  );
  // x for sample index i (0..n) maps to pixel column.
  const x = (i) => (i / Math.max(1, n)) * GRAPH_W;
  // y maps cp to vertical: top = +∞ (white winning), bottom = -∞ (black).
  const y = (cp) => {
    const frac = cpToWhiteFrac(cp);
    return GRAPH_H * (1 - frac);
  };
  const points = cps.map((cp, i) => [x(i), y(cp)]);
  const linePath = _smoothPath(points);
  // Filled white area below the curve.
  const fillWhite =
    `${linePath} L${GRAPH_W.toFixed(2)},${GRAPH_H} L0,${GRAPH_H} Z`;
  // Filled dark area above the curve.
  const fillBlack =
    `${linePath} L${GRAPH_W.toFixed(2)},0 L0,0 Z`;
  // Move-number gridlines every 5 full moves.
  const grid = [];
  const moveSpacing = 10; // plies = 5 full moves
  for (let p = moveSpacing; p < n; p += moveSpacing) {
    const gx = x(p).toFixed(2);
    grid.push(
      `<line class="graph-grid" x1="${gx}" y1="0" x2="${gx}" y2="${GRAPH_H}" />`
    );
  }
  // Dots only on classification-bearing samples (skip the leading start
  // sample which has no move).
  const dotClasses = new Set([
    "brilliant",
    "great",
    "inaccuracy",
    "mistake",
    "blunder",
    "miss",
  ]);
  const dots = moves.map((m, i) => {
    const cls = m.classification;
    if (!dotClasses.has(cls)) return "";
    const fill = REVIEW_COLOR[cls] || "#888";
    return `<circle class="graph-dot cls-${cls}" data-idx="${i}" cx="${x(i + 1).toFixed(2)}" cy="${y(cps[i + 1]).toFixed(2)}" r="${GRAPH_DOT_RADIUS}" fill="${fill}" stroke="#000" stroke-width="0.4" />`;
  }).join("");
  svg.innerHTML = `
    <rect class="graph-bg-black" x="0" y="0" width="${GRAPH_W}" height="${GRAPH_H}" />
    <path d="${fillWhite}" fill="#f4f5f6" />
    <path d="${fillBlack}" fill="rgba(20,22,28,0.05)" />
    ${grid.join("")}
    <line class="graph-zero" x1="0" y1="${GRAPH_H / 2}" x2="${GRAPH_W}" y2="${GRAPH_H / 2}" />
    <path class="graph-line" d="${linePath}" />
    <line id="graph-cursor-line" class="graph-cursor" x1="0" y1="0" x2="0" y2="${GRAPH_H}" style="display:none" />
    ${dots}
  `;
  // Pointer interactions.
  const onPointerMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * GRAPH_W;
    // idx = which move (0..n-1)
    const idx = Math.max(0, Math.min(n - 1, Math.round((px / GRAPH_W) * n) - 1));
    const cp = cps[idx + 1];
    const cursor = svg.querySelector("#graph-cursor-line");
    if (cursor) {
      cursor.style.display = "";
      cursor.setAttribute("x1", x(idx + 1).toFixed(2));
      cursor.setAttribute("x2", x(idx + 1).toFixed(2));
    }
    // Tooltip.
    const m = moves[idx];
    const evalText = (() => {
      if (cp >= 99000) return `M${100000 - cp}`;
      if (cp <= -99000) return `−M${cp + 100000}`;
      const v = (cp / 100).toFixed(2);
      return cp > 0 ? `+${v}` : v;
    })();
    const moveNum = Math.ceil(m.ply / 2);
    const dot = m.side === "b" ? "..." : ".";
    tip.textContent = `${moveNum}${dot} ${m.move_san} ${evalText}`;
    tip.hidden = false;
    // Position tip in the wrap, in pixel coords.
    const wrapRect = wrap.getBoundingClientRect();
    const px_in_wrap = ((idx + 1) / n) * wrapRect.width;
    const py_in_wrap = (y(cp) / GRAPH_H) * wrapRect.height;
    tip.style.left = `${px_in_wrap}px`;
    tip.style.top = `${py_in_wrap - 6}px`;
  };
  const onPointerLeave = () => {
    tip.hidden = true;
    const cursor = svg.querySelector("#graph-cursor-line");
    if (cursor) cursor.style.display = "none";
  };
  const onClick = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * GRAPH_W;
    const idx = Math.max(0, Math.min(n - 1, Math.round((px / GRAPH_W) * n) - 1));
    jumpToReviewIdx(idx);
  };
  svg.onpointermove = onPointerMove;
  svg.onpointerleave = onPointerLeave;
  svg.onclick = onClick;
}

function renderKeyMoments(moments) {
  const host = document.getElementById("review-key-moments");
  if (!host) return;
  if (!moments || moments.length === 0) { host.innerHTML = ""; return; }
  const rows = moments.map((k) => {
    const side = k.side === "w" ? "Белые" : "Чёрные";
    const moveNum = Math.ceil(k.ply / 2);
    return `<li data-ply="${k.ply}" title="${escapeHtml(k.note || "")}">
      <span class="km-ply">${moveNum}${k.side === "b" ? "..." : "."}</span>
      <span class="km-icon cls-${k.classification}" style="color:inherit">${REVIEW_ICONS[k.classification] || ""}</span>
      <span class="km-san">${side} ${escapeHtml(k.move_san)}</span>
      <span class="km-delta">ΔWP ${k.wp_delta}%</span>
    </li>`;
  }).join("");
  // Only offer drill if at least one moment is "actionable"
  // (excludes book / forced / best — there is no lesson there).
  const drillable = moments.some((m) =>
    ["inaccuracy", "mistake", "blunder", "miss"].includes(m.classification)
  );
  const drillBtn = drillable
    ? `<button id="btn-drill-start" type="button" class="drill-start-btn">🎯 Тренировать критические моменты</button>`
    : "";
  host.innerHTML = `<h3>Ключевые моменты ${drillBtn}</h3><ol>${rows}</ol>`;
  host.querySelectorAll("li[data-ply]").forEach((li) => {
    li.addEventListener("click", () => {
      const ply = parseInt(li.dataset.ply, 10);
      jumpToReviewIdx(ply - 1);
    });
  });
  const startBtn = document.getElementById("btn-drill-start");
  if (startBtn) startBtn.addEventListener("click", () => startDrill(moments));
}

// ---------- Drill mode (chess.com Lessons-style practice) ----------

function startDrill(moments) {
  const filtered = (moments || []).filter((m) =>
    ["inaccuracy", "mistake", "blunder", "miss"].includes(m.classification)
  );
  if (filtered.length === 0 || !review.analysis) {
    setStatus("Нет критических моментов для тренировки.", "info");
    return;
  }
  // Stash the unfiltered list so "Заново" on the summary screen can
  // restart with the same set of moments.
  state.drill.sourceMoments = moments || [];
  state.drill.active = true;
  state.drill.moments = filtered;
  state.drill.idx = 0;
  state.drill.streak = 0;
  state.drill.bestStreak = 0;
  state.drill.outcomes = [];
  state.drill.startTime = Date.now();
  state.drill.finishedAt = 0;
  state.drill.finished = false;
  loadDrillMoment();
}

function loadDrillMoment() {
  const km = state.drill.moments[state.drill.idx];
  if (!km || !review.analysis) { exitDrill(); return; }
  const moves = review.analysis.moves;
  const moveData = moves[km.ply - 1];
  if (!moveData || !moveData.best_move_uci) {
    nextDrill();
    return;
  }
  // The puzzle position is the FEN *before* the bad move was played.
  const fenBefore = km.ply === 1
    ? review.game.starting_fen
    : moves[km.ply - 2].fen_after;
  state.drill.expectedUci = moveData.best_move_uci;
  state.drill.expectedSan = moveData.best_move_san || "";
  state.drill.side = moveData.side;
  state.drill.plyIdx = km.ply - 1;
  state.drill.feedback = null;
  state.drill.attempts = 0;
  state.drill.hintUsed = false;
  state.drill.answerShown = false;
  loadFen(fenBefore);
  state.lastMove = null;
  state.reviewBadge = null;
  state.bestArrow = null;
  state.bestPv = null;
  renderBoard();
  renderDrillUi();
  // Hide normal review board hint while drilling.
  const hint = document.getElementById("board-hint");
  if (hint) hint.textContent = "";
}

function tryDrillMove(from, to) {
  if (!state.drill.active) return;
  const c = ensureFreeplayChess();
  if (!c) return;
  const moveTo = freeplayCastlingTarget(c, from, to) || to;
  // Validate legality first.
  let move;
  try { move = c.move({ from, to: moveTo, promotion: "q" }); } catch { move = null; }
  if (!move) {
    setStatus("Нелегальный ход.", "error");
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
    // Drills are pure analysis — no Stockfish opponent — so no illegal sound.
    return;
  }
  // UCI of the player's attempt (always with q-promotion when applicable).
  const playedUci =
    move.from + move.to + (move.promotion ? move.promotion : "");
  const expected = state.drill.expectedUci;
  // Match — strip optional promotion suffix and compare prefix-then-suffix.
  const sameMove =
    playedUci === expected
    || (expected.length >= 4
        && playedUci.slice(0, 4) === expected.slice(0, 4)
        && (expected.length === 4 || playedUci.slice(4) === expected.slice(4)));
  if (sameMove) {
    // Score this moment: first-try-no-hint = full point, retry = half
    // point, hint used = quarter, answer shown = 0.
    let outcome;
    if (state.drill.answerShown)        outcome = "given-up";
    else if (state.drill.hintUsed)      outcome = "solved-hint";
    else if (state.drill.attempts > 0)  outcome = "solved-retry";
    else                                outcome = "solved";
    state.drill.outcomes[state.drill.idx] = outcome;
    if (outcome === "solved") {
      state.drill.streak += 1;
      if (state.drill.streak > state.drill.bestStreak) {
        state.drill.bestStreak = state.drill.streak;
      }
    } else {
      state.drill.streak = 0;
    }
    // Show the move on the board with a 'best' badge as positive
    // feedback, then auto-advance after a beat.
    loadFen(c.fen());
    state.lastMove = { from: move.from, to: move.to };
    state.reviewBadge = { square: move.to, classification: "best" };
    state.bestArrow = null;
    state.bestPv = null;
    state.drill.feedback = "correct";
    renderBoard();
    renderDrillUi();
    spawnDrillCelebration("ok");
    playMoveSoundFor(move, { isOwn: true, inCheck: c.isCheck() });
    setTimeout(nextDrill, 1500);
  } else {
    state.drill.attempts += 1;
    state.drill.feedback = "wrong";
    // Don't apply the wrong move — let the user try again.
    state.selectedSquare = null;
    state.legalTargets = [];
    renderDrillUi();
    // Tiny visual nudge: flash the destination square red briefly.
    const cell = boardEl.querySelector(`.square[data-square="${move.to}"]`);
    if (cell) {
      cell.classList.add("drill-flash-bad");
      setTimeout(() => cell.classList.remove("drill-flash-bad"), 700);
    }
    spawnDrillCelebration("bad");
  }
}

function nextDrill() {
  if (!state.drill.active) return;
  // If the user never solved this moment (e.g. "Пропустить")
  // we still record an outcome so the summary is correct.
  if (state.drill.outcomes[state.drill.idx] == null) {
    state.drill.outcomes[state.drill.idx] = state.drill.answerShown
      ? "given-up"
      : "given-up";
    state.drill.streak = 0;
  }
  if (state.drill.idx + 1 >= state.drill.moments.length) {
    finishDrill();
    return;
  }
  state.drill.idx += 1;
  loadDrillMoment();
}

function finishDrill() {
  state.drill.finishedAt = Date.now();
  state.drill.finished = true;
  state.drill.feedback = null;
  state.drill.expectedUci = null;
  state.drill.expectedSan = null;
  // Clear any board hint artefacts.
  state.bestArrow = null;
  state.bestPv = null;
  state.reviewBadge = null;
  renderBoard();
  renderDrillUi();
  spawnDrillCelebration("finish");
}

function restartDrill() {
  if (!state.drill.sourceMoments || state.drill.sourceMoments.length === 0) {
    exitDrill(false);
    return;
  }
  startDrill(state.drill.sourceMoments);
}

function exitDrill(finished) {
  const wasActive = state.drill.active || state.drill.finished;
  state.drill.active = false;
  state.drill.finished = false;
  state.drill.moments = [];
  state.drill.outcomes = [];
  state.drill.expectedUci = null;
  state.drill.expectedSan = null;
  state.drill.feedback = null;
  state.drill.streak = 0;
  state.drill.bestStreak = 0;
  state.drill.startTime = 0;
  state.drill.finishedAt = 0;
  renderDrillUi();
  if (!wasActive) return;
  if (finished) {
    setStatus("Тренировка завершена — все ключевые моменты пройдены.", "info");
  }
  // Restore review view if there was one.
  if (review.activeIdx >= 0) jumpToReviewIdx(review.activeIdx);
}

// Drill scoring helper: convert per-moment outcomes into chess.com-
// style aggregate stats for the running header / summary card.
function computeDrillStats() {
  const outcomes = state.drill.outcomes || [];
  const total = state.drill.moments.length;
  let solved = 0, retry = 0, hint = 0, given = 0;
  for (const o of outcomes) {
    if (o === "solved") solved += 1;
    else if (o === "solved-retry") retry += 1;
    else if (o === "solved-hint") hint += 1;
    else if (o === "given-up") given += 1;
  }
  const seen = solved + retry + hint + given;
  // Weighted score (1 / 0.5 / 0.25 / 0). Used for the percentage badge.
  const score = solved * 1 + retry * 0.5 + hint * 0.25;
  const pct = seen ? Math.round((score / seen) * 100) : 0;
  return { total, solved, retry, hint, given, seen, score, pct };
}

function _formatMs(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

// Visual celebration overlay that pops a glyph centred on the board.
// 'ok' = green check, 'bad' = red X, 'finish' = trophy + sparkle.
function spawnDrillCelebration(kind) {
  if (!boardEl) return;
  let glyph, cls;
  if (kind === "ok")          { glyph = "✔"; cls = "drill-burst-ok"; }
  else if (kind === "bad")    { glyph = "✖"; cls = "drill-burst-bad"; }
  else if (kind === "finish") { glyph = "🏆"; cls = "drill-burst-finish"; }
  else                        { return; }
  const el = document.createElement("div");
  el.className = `drill-burst ${cls}`;
  el.textContent = glyph;
  boardEl.appendChild(el);
  // Auto-remove after the CSS animation finishes.
  setTimeout(() => el.remove(), kind === "finish" ? 1800 : 900);
}

function renderDrillUi() {
  const host = document.getElementById("drill-panel");
  if (!host) return;
  if (!state.drill.active && !state.drill.finished) {
    host.innerHTML = "";
    host.style.display = "none";
    return;
  }
  host.style.display = "block";

  // Summary card after the last moment.
  if (state.drill.finished) {
    host.classList.add("is-finished");
    const s = computeDrillStats();
    const elapsed = state.drill.finishedAt - state.drill.startTime;
    const accent = s.pct >= 80 ? "great" : s.pct >= 50 ? "good" : "tough";
    host.innerHTML = `
      <div class="drill-summary drill-summary-${accent}">
        <div class="drill-summary-head">
          <span class="drill-summary-trophy">🏆</span>
          <div class="drill-summary-title">Тренировка завершена</div>
          <div class="drill-summary-pct">${s.pct}%</div>
        </div>
        <div class="drill-summary-grid">
          <div class="ds-cell"><div class="ds-label">Решено</div><div class="ds-val">${s.solved + s.retry + s.hint} / ${s.total}</div></div>
          <div class="ds-cell"><div class="ds-label">Сразу</div><div class="ds-val ds-good">${s.solved}</div></div>
          <div class="ds-cell"><div class="ds-label">С повтором</div><div class="ds-val ds-warn">${s.retry}</div></div>
          <div class="ds-cell"><div class="ds-label">С подсказкой</div><div class="ds-val ds-warn">${s.hint}</div></div>
          <div class="ds-cell"><div class="ds-label">Пропущено</div><div class="ds-val ds-bad">${s.given}</div></div>
          <div class="ds-cell"><div class="ds-label">Лучшая серия</div><div class="ds-val">🔥 ${s.solved ? state.drill.bestStreak : 0}</div></div>
          <div class="ds-cell"><div class="ds-label">Время</div><div class="ds-val">${_formatMs(elapsed)}</div></div>
        </div>
        <div class="drill-summary-actions">
          <button id="drill-restart" type="button" class="drill-primary">🔁 Заново</button>
          <button id="drill-exit" type="button" class="drill-secondary">✕ Закрыть</button>
        </div>
      </div>
    `;
    const restartBtn = document.getElementById("drill-restart");
    if (restartBtn) restartBtn.onclick = restartDrill;
    const exitBtn = document.getElementById("drill-exit");
    if (exitBtn) exitBtn.onclick = () => exitDrill(true);
    return;
  }

  host.classList.remove("is-finished");
  const total = state.drill.moments.length;
  const cur = state.drill.idx + 1;
  const km = state.drill.moments[state.drill.idx];
  const cls = km ? km.classification : "";
  const themeLabel = REVIEW_LABELS[cls] || "Критический момент";
  const themeIcon = REVIEW_ICONS[cls] || "⚠";
  const sideLabel = state.drill.side === "w" ? "Белые" : "Чёрные";
  const stats = computeDrillStats();
  const progressPct = Math.round(((cur - 1) / Math.max(1, total)) * 100);
  const streak = state.drill.streak;
  const streakBadge = streak >= 3
    ? `<span class="drill-streak">🔥 ${streak}</span>`
    : `<span class="drill-streak drill-streak-empty">•</span>`;

  let feedback = "";
  if (state.drill.feedback === "correct") {
    const bonus = streak >= 5 ? " · Огонь! Серия ×" + streak
                 : streak >= 3 ? " · Серия ×" + streak
                 : "";
    feedback = `<div class="drill-msg drill-ok">✓ Верно! Лучший ход — <b>${escapeHtml(state.drill.expectedSan)}</b>${bonus}</div>`;
  } else if (state.drill.feedback === "wrong") {
    const tip = state.drill.attempts >= 2
      ? "Нажми <b>Подсказку</b>, чтобы увидеть фигуру."
      : "Попробуй ещё раз.";
    feedback = `<div class="drill-msg drill-bad">✕ Не лучший ход. ${tip}</div>`;
  } else if (state.drill.answerShown) {
    feedback = `<div class="drill-msg drill-info">Показан ответ — <b>${escapeHtml(state.drill.expectedSan)}</b>. Повтори ход на доске или нажми <b>Дальше</b>.</div>`;
  } else if (state.drill.hintUsed) {
    feedback = `<div class="drill-msg drill-info">Подсказка: исходная клетка подсвечена.</div>`;
  }

  // Right-hand action: "Skip" before user solves, "Next" after answer
  // is shown so user can move on without playing it.
  const advanceBtn = state.drill.answerShown
    ? `<button id="drill-next" type="button" class="drill-primary">→ Дальше</button>`
    : `<button id="drill-skip" type="button" class="drill-secondary">⤳ Пропустить</button>`;

  host.innerHTML = `
    <div class="drill-head">
      <div class="drill-head-left">
        <span class="drill-title">🎯 Тренировка · ${cur} / ${total}</span>
        <span class="drill-stats">
          <span class="ds-good" title="Решено с первого раза">✓ ${stats.solved}</span>
          <span class="ds-warn" title="С повтором или подсказкой">○ ${stats.retry + stats.hint}</span>
          <span class="ds-bad" title="Пропущено">✕ ${stats.given}</span>
          ${streakBadge}
        </span>
      </div>
      <button id="drill-exit" type="button" class="drill-secondary">✕ Выйти</button>
    </div>
    <div class="drill-progress">
      <div class="drill-progress-fill" style="width: ${progressPct}%"></div>
    </div>
    <div class="drill-prompt">
      Ход за <b>${sideLabel}</b>. Найди лучший ход.
    </div>
    ${feedback}
    <div class="drill-actions">
      <button id="drill-hint" type="button" class="drill-secondary" ${state.drill.answerShown ? "disabled" : ""}>💡 Подсказка</button>
      <button id="drill-show" type="button" class="drill-secondary" ${state.drill.answerShown ? "disabled" : ""}>👁 Показать ответ</button>
      ${advanceBtn}
    </div>
  `;
  const exitBtn = document.getElementById("drill-exit");
  if (exitBtn) exitBtn.onclick = () => exitDrill(false);
  const hintBtn = document.getElementById("drill-hint");
  if (hintBtn) hintBtn.onclick = () => {
    const u = state.drill.expectedUci;
    if (u && u.length >= 4) {
      state.drill.hintUsed = true;
      // Highlight the source square only (small hint, not the full arrow).
      state.bestArrow = { from: u.slice(0, 2), to: u.slice(0, 2) };
      renderBoard();
      renderDrillUi();
    }
  };
  const showBtn = document.getElementById("drill-show");
  if (showBtn) showBtn.onclick = () => {
    const u = state.drill.expectedUci;
    if (u && u.length >= 4) {
      state.drill.answerShown = true;
      state.drill.feedback = null;
      state.bestArrow = { from: u.slice(0, 2), to: u.slice(2, 4) };
      renderBoard();
      renderDrillUi();
    }
  };
  const skipBtn = document.getElementById("drill-skip");
  if (skipBtn) skipBtn.onclick = nextDrill;
  const nextBtn = document.getElementById("drill-next");
  if (nextBtn) nextBtn.onclick = nextDrill;
}

// ---------- Puzzle mode (chess.com-style tactics trainer) ----------

// Number of recently-served puzzle ids to remember when asking the
// backend for the next random puzzle (so the same puzzle doesn't
// come up twice in a row).
const PUZZLE_RECENT_HISTORY = 25;

// Persistent counters survive a full reload — the user keeps their
// rating + streak across sessions.
function _loadPuzzleSession() {
  try {
    const raw = localStorage.getItem("cs.puzzle.session");
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      if (typeof data.sessionRating === "number") {
        state.puzzle.sessionRating = data.sessionRating;
      }
      if (data.sessionStats && typeof data.sessionStats === "object") {
        state.puzzle.sessionStats = {
          ...state.puzzle.sessionStats,
          ...data.sessionStats,
        };
      }
      if (Array.isArray(data.history)) {
        state.puzzle.history = data.history.slice(-30);
      }
    }
  } catch (_) { /* ignore */ }
}
function _savePuzzleSession() {
  try {
    localStorage.setItem("cs.puzzle.session", JSON.stringify({
      sessionRating: state.puzzle.sessionRating,
      sessionStats: state.puzzle.sessionStats,
      history: state.puzzle.history.slice(-30),
    }));
  } catch (_) { /* ignore */ }
}

function enterPuzzleView() {
  // Snapshot board orientation so we can restore it on the way out.
  if (state.puzzle.flippedSnapshot === null) {
    state.puzzle.flippedSnapshot = state.flipped;
  }
  // We deliberately do *not* open the solo-broadcast WS here — that
  // happens lazily in loadNextPuzzle(), the first moment a puzzle is
  // actually on the board. Otherwise an idle user sitting on the
  // start screen would show up in the Оффлайн tab with the empty
  // starting position, and spectators could "watch" before the
  // player has clicked anything.
  // Puzzle mode requires legal-move dispatch — force legal mode on so
  // drag/click attempts are routed through `tryFreeplayMove`.
  if (!state.legalMode) setBoardMode(true);
  _loadPuzzleSession();
  // If we deferred an auto-next while the user was on Main, load it now.
  if (state.puzzle.needsNextOnReturn) {
    state.puzzle.needsNextOnReturn = false;
    loadNextPuzzle();
    return;
  }
  // Auto-load a puzzle when entering an empty view — but only if the
  // user has explicitly clicked "Начать игру". Idle entry shows the
  // start screen instead so we don't ambush anyone with a puzzle they
  // didn't ask for.
  if (!state.puzzle.current) {
    if (state.puzzle.idle) {
      renderPuzzleUi();
      return;
    }
    loadNextPuzzle();
  } else {
    // Replay the current puzzle's start position (in case the user
    // bounced between tabs).
    _restorePuzzleBoard();
    // Re-flip board to the solver's side if user changed orientation
    // on another view.
    const wantFlipped = state.puzzle.side === "b";
    if (state.flipped !== wantFlipped) {
      state.flipped = wantFlipped;
      renderBoard();
    }
    renderPuzzleUi();
    if (state.puzzle.active) _startPuzzleTimer();
  }
}

function leavePuzzleView() {
  // The puzzle stays live (timer keeps counting via wall-clock against
  // `state.puzzle.startedAt`) so users can't dodge a hard puzzle by
  // bouncing tabs and hitting "Следующая" without penalty. Board input
  // is gated on `state.view === "puzzle"` instead of the active flag.
  _stopPuzzleTimer();
  // Drop the solo-broadcast connection — outside puzzle view there's
  // nothing meaningful to broadcast and we don't want to clutter the
  // "Оффлайн" list with idle entries.
  try { presenceDisconnect(); } catch (_) { /* ignore */ }
  // If an auto-next was pending (after a fail), defer it until the
  // user actually returns to the puzzle tab — otherwise loadNextPuzzle
  // would slap a puzzle FEN onto the Main / Analysis board.
  if (state.puzzle.pendingNext) {
    clearTimeout(state.puzzle.pendingNext);
    state.puzzle.pendingNext = null;
    state.puzzle.needsNextOnReturn = true;
  }
  // Restore orientation only if we were the one that flipped it.
  if (state.puzzle.flippedSnapshot !== null
      && state.flipped !== state.puzzle.flippedSnapshot) {
    state.flipped = state.puzzle.flippedSnapshot;
  }
  state.puzzle.flippedSnapshot = null;
  state.bestArrow = null;
  state.bestPv = null;
  state.reviewBadge = null;
  state.lastMove = null;
  // Reset board to a neutral starting position so Main / Analysis
  // views aren't littered with a half-finished puzzle.
  try { loadFen(STARTPOS_FEN); } catch (_) { /* ignore */ }
  renderBoard();
}

// Build a rating window around the user's current rating so the next
// puzzle's difficulty scales with skill — chess.com-style. Window
// starts tight (±100) and expands if the bank has nothing close by.
function _puzzleRatingWindow() {
  const r = state.puzzle.sessionRating;
  // Wider lower bound for very high ratings (small puzzle pool above 2200).
  if (r >= 2000) return [r - 250, r + 350];
  if (r >= 1500) return [r - 150, r + 250];
  if (r >= 900)  return [r - 200, r + 200];
  return [Math.max(400, r - 200), r + 250];
}

async function loadNextPuzzle() {
  // In party mode the server pushes the next puzzle over the WebSocket;
  // never reach into the solo /api/puzzle endpoint while a match is live.
  if (state.party.active && state.party.status === "playing") {
    renderPuzzleStatsBar();
    return;
  }
  // Any active puzzle load implicitly leaves the idle "Start" screen
  // — once the user has any puzzle on the board they're committed.
  state.puzzle.idle = false;
  // Now that a real puzzle is being loaded, register in the solo
  // presence registry so the Оффлайн tab can find this player. We
  // skip this in party mode (returned earlier above).
  try { presenceConnect(); } catch (_) { /* ignore */ }
  const card = document.getElementById("puzzle-card");
  const actions = document.getElementById("puzzle-actions");
  if (card)    card.innerHTML = `<div class="puzzle-empty">Загружаем задачу…</div>`;
  if (actions) actions.innerHTML = "";
  renderPuzzleStatsBar();
  renderPuzzleHistory();
  // Auto-scale difficulty by user rating (chess.com-style — no manual filter).
  const [minR, maxR] = _puzzleRatingWindow();
  const params = new URLSearchParams();
  params.set("min_rating", String(minR));
  params.set("max_rating", String(maxR));
  if (state.puzzle.recentIds.length) {
    params.set("exclude", state.puzzle.recentIds.join(","));
  }
  let p;
  try {
    p = await api(`/api/puzzle/random?${params.toString()}`);
  } catch (err) {
    if (card) card.innerHTML =
      `<div class="puzzle-empty">Не удалось загрузить задачу: ${escapeHtml(String(err && err.message || err))}</div>`;
    return;
  }
  startPuzzle(p);
}

function startPuzzle(puzzle) {
  if (!puzzle || !puzzle.fen || !Array.isArray(puzzle.moves) || puzzle.moves.length < 2) {
    const card = document.getElementById("puzzle-card");
    if (card) card.innerHTML = `<div class="puzzle-empty">Задача повреждена.</div>`;
    return;
  }
  // Cancel any pending auto-next from the previous puzzle.
  if (state.puzzle.pendingNext) {
    clearTimeout(state.puzzle.pendingNext);
    state.puzzle.pendingNext = null;
  }
  _stopPuzzleTimer();
  state.puzzle.current = puzzle;
  state.puzzle.moves = puzzle.moves.slice();
  state.puzzle.fenStart = puzzle.fen;
  state.puzzle.side = puzzle.side_to_solve || "w";
  state.puzzle.feedback = null;
  state.puzzle.attempts = 0;
  state.puzzle.hintUsed = false;
  state.puzzle.active = true;
  state.puzzle.startedAt = 0;
  state.puzzle.solveMs = 0;
  // Anti-dup history.
  state.puzzle.recentIds.unshift(puzzle.id);
  if (state.puzzle.recentIds.length > PUZZLE_RECENT_HISTORY) {
    state.puzzle.recentIds.length = PUZZLE_RECENT_HISTORY;
  }
  // Restore the board to FEN-before-setup, then animate the setup move
  // so the user sees the threat that triggered the puzzle.
  try { loadFen(puzzle.fen); } catch (e) {
    const card = document.getElementById("puzzle-card");
    if (card) card.innerHTML = `<div class="puzzle-empty">Bad FEN: ${escapeHtml(String(e))}</div>`;
    return;
  }
  // Auto-flip board so the solver always faces their own pieces from
  // the bottom (chess.com convention).
  const wantFlipped = state.puzzle.side === "b";
  if (state.flipped !== wantFlipped) {
    state.flipped = wantFlipped;
  }
  state.bestArrow = null;
  state.bestPv = null;
  state.reviewBadge = null;
  state.lastMove = null;
  renderBoard();
  renderPuzzleUi();
  // Sync spectators to the new puzzle's pre-setup FEN + flip
  // immediately so they switch boards in lockstep with the player.
  _partyReportPosition(puzzle.fen, { lastMove: null });
  // After a brief beat, animate the opponent's setup move (shorter
  // delay = snappier feel, fewer perceived "lag" complaints).
  state.puzzle.nextIdx = 0;
  setTimeout(() => _playPuzzleSetupMove(), 220);
}

function _restorePuzzleBoard() {
  // Idempotent re-render of the current puzzle's *initial* position
  // (after the setup move has been applied). Used when the user
  // navigates away and back to the puzzle tab.
  if (!state.puzzle.current) return;
  try { loadFen(state.puzzle.fenStart); } catch (_) { return; }
  const c = ensureFreeplayChess();
  if (!c) return;
  // Apply the setup move (and any solver moves already made before
  // bouncing tabs). For simplicity we just re-apply moves[0..nextIdx-1].
  for (let i = 0; i < state.puzzle.nextIdx; i++) {
    const u = state.puzzle.moves[i];
    if (!u || u.length < 4) break;
    try {
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" });
    } catch { break; }
  }
  loadFen(c.fen());
  renderBoard();
}

function _playPuzzleSetupMove() {
  if (!state.puzzle.active || !state.puzzle.current) return;
  const u = state.puzzle.moves[0];
  if (!u || u.length < 4) return;
  const c = ensureFreeplayChess();
  if (!c) return;
  let move;
  try {
    move = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" });
  } catch { move = null; }
  if (!move) return;
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  renderBoard();
  playMoveSoundFor(move, { isOwn: false, inCheck: c.isCheck() });
  // Push the post-setup position to spectators so they see the same
  // board the player sees (with the opponent's setup move already
  // played and highlighted) — without this they kept staring at the
  // pre-setup FEN until the player made their first solving move.
  _partyReportPosition(c.fen(), { lastMove: state.lastMove });
  state.puzzle.nextIdx = 1;
  // Solver clock starts now (after setup move is on the board).
  state.puzzle.startedAt = Date.now();
  _startPuzzleTimer();
  renderPuzzleUi();
}

// Live timer pulse — repaints just the timer chip every 500ms so the
// user sees their solve speed without re-rendering the full UI.
function _startPuzzleTimer() {
  _stopPuzzleTimer();
  state.puzzle.timerHandle = setInterval(_paintPuzzleTimer, 500);
  _paintPuzzleTimer();
}
function _stopPuzzleTimer() {
  if (state.puzzle.timerHandle) {
    clearInterval(state.puzzle.timerHandle);
    state.puzzle.timerHandle = null;
  }
}
function _paintPuzzleTimer() {
  const el = document.getElementById("puzzle-timer-val");
  if (!el) return;
  const ms = state.puzzle.startedAt
    ? (state.puzzle.solveMs || (Date.now() - state.puzzle.startedAt))
    : 0;
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  el.textContent = `${m}:${String(s).padStart(2, "0")}`;
}

function tryPuzzleMove(from, to) {
  if (!state.puzzle.active) return;
  const c = ensureFreeplayChess();
  if (!c) return;
  const moveTo = freeplayCastlingTarget(c, from, to) || to;
  let move;
  try { move = c.move({ from, to: moveTo, promotion: "q" }); } catch { move = null; }
  if (!move) {
    setStatus("Нелегальный ход.", "error");
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
    return;
  }
  const playedUci =
    move.from + move.to + (move.promotion ? move.promotion : "");
  const expected = state.puzzle.moves[state.puzzle.nextIdx] || "";
  const sameMove =
    playedUci === expected
    || (expected.length >= 4
        && playedUci.slice(0, 4) === expected.slice(0, 4)
        && (expected.length === 4 || playedUci.slice(4) === expected.slice(4)));
  if (!sameMove) {
    // chess.com one-strike rule: first wrong move = puzzle is done,
    // user loses Δ rating, auto-advance to next puzzle. No retries.
    try { c.undo(); } catch (_) { /* ignore */ }
    state.puzzle.attempts = 1;
    state.selectedSquare = null;
    state.legalTargets = [];
    const cell = boardEl && boardEl.querySelector(`.square[data-square="${move.to}"]`);
    if (cell) {
      cell.classList.add("puzzle-flash-bad");
      setTimeout(() => cell.classList.remove("puzzle-flash-bad"), 700);
    }
    finalizePuzzle("failed");
    // Auto-advance after a short beat so the user sees the red flash
    // and the rating delta before the next puzzle loads.
    if (state.puzzle.pendingNext) clearTimeout(state.puzzle.pendingNext);
    state.puzzle.pendingNext = setTimeout(() => {
      state.puzzle.pendingNext = null;
      loadNextPuzzle();
    }, 1300);
    return;
  }
  // Correct! Apply the user's move visually.
  loadFen(c.fen());
  _partyReportPosition(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  state.reviewBadge = { square: move.to, classification: "best" };
  state.bestArrow = null;
  state.bestPv = null;
  state.puzzle.feedback = "correct";
  state.puzzle.nextIdx += 1;
  renderBoard();
  renderPuzzleUi();
  playMoveSoundFor(move, { isOwn: true, inCheck: c.isCheck() });
  const okCell = boardEl && boardEl.querySelector(`.square[data-square="${move.to}"]`);
  if (okCell) {
    okCell.classList.add("puzzle-flash-ok");
    setTimeout(() => okCell.classList.remove("puzzle-flash-ok"), 500);
  }
  // Check if puzzle is fully solved.
  if (state.puzzle.nextIdx >= state.puzzle.moves.length) {
    finalizePuzzle("solved");
    return;
  }
  // Otherwise play the forced opponent reply quickly so the next
  // solver move is unblocked without a perceptible wait.
  setTimeout(() => _playPuzzleOpponentReply(), 220);
}

function _playPuzzleOpponentReply() {
  if (!state.puzzle.active) return;
  const u = state.puzzle.moves[state.puzzle.nextIdx];
  if (!u || u.length < 4) return;
  const c = ensureFreeplayChess();
  if (!c) return;
  let move;
  try {
    move = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" });
  } catch { move = null; }
  if (!move) return;
  loadFen(c.fen());
  _partyReportPosition(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  state.reviewBadge = null;
  renderBoard();
  playMoveSoundFor(move, { isOwn: false, inCheck: c.isCheck() });
  state.puzzle.nextIdx += 1;
  // Clear the per-move "correct" feedback once the opponent has moved.
  state.puzzle.feedback = null;
  renderPuzzleUi();
  if (state.puzzle.nextIdx >= state.puzzle.moves.length) {
    finalizePuzzle("solved");
  }
}

// chess.com-style rating delta — pure skill, with a speed bonus
// applied only to clean (no-hint) solves so faster solves of the same
// puzzle yield more rating than slow ones.
//
//   • didSolve === true  → Δ = +K * (1 - expected) * speedFactor
//   • didSolve === false → Δ = -K * expected
//   • outcome === "hint" → Δ = 0  (handled by caller passing didSolve=null)
//
// expected = standard Elo expectation that a player at userRating beats
// a puzzle of puzzleRating. K-factor scales with rating bracket.
function _ratingDelta(userRating, puzzleRating, didSolve, solveMs) {
  if (didSolve === null) return 0; // hint-assisted solve = no Δ
  const expected = 1 / (1 + Math.pow(10, (puzzleRating - userRating) / 400));
  // K shrinks as the user climbs (chess.com-style: harder to gain 1 pt at 2000+).
  let k;
  if      (userRating >= 2200) k = 14;
  else if (userRating >= 1700) k = 18;
  else if (userRating >= 1200) k = 22;
  else                         k = 26;
  if (didSolve) {
    // Speed factor: 1.0 baseline, up to +50% if solved in under 8s,
    // down to 0.6 if it took the user 90s+. Curve is monotone.
    const sec = Math.max(0, (solveMs || 0) / 1000);
    let speed;
    if      (sec <= 8)  speed = 1.5;
    else if (sec <= 15) speed = 1.3;
    else if (sec <= 30) speed = 1.1;
    else if (sec <= 60) speed = 1.0;
    else if (sec <= 90) speed = 0.85;
    else                speed = 0.7;
    const raw = k * (1 - expected) * speed;
    // Floor at +1 so a clean solve always nudges rating upward.
    return Math.max(1, Math.round(raw));
  }
  // Loss: cap at -1 so a single error always costs at least 1 pt.
  const raw = -k * expected;
  return Math.min(-1, Math.round(raw));
}

function finalizePuzzle(result) {
  if (!state.puzzle.active && result !== "skipped") return;
  state.puzzle.active = false;
  _stopPuzzleTimer();
  // Snapshot solve time before zeroing startedAt.
  state.puzzle.solveMs = state.puzzle.startedAt
    ? (Date.now() - state.puzzle.startedAt) : 0;
  let outcome;          // 'solved' | 'solved-hint' | 'failed' | 'skipped'
  let didSolve = false; // for rating math (true=win, false=loss, null=neutral)
  if (result === "solved") {
    if (state.puzzle.hintUsed)         outcome = "solved-hint";
    else                               outcome = "solved";
    didSolve = (outcome === "solved-hint") ? null : true;
  } else if (result === "skipped") {
    outcome = "skipped";
    didSolve = false;
  } else {
    outcome = "failed";
    didSolve = false;
  }
  state.puzzle.feedback =
    (outcome === "solved" || outcome === "solved-hint") ? "solved" : "shown";
  // Update session counters.
  const ss = state.puzzle.sessionStats;
  if (outcome === "solved" || outcome === "solved-hint") {
    ss.solved += 1;
    ss.streak += 1;
    if (ss.streak > ss.bestStreak) ss.bestStreak = ss.streak;
  } else if (outcome === "failed") {
    ss.wrong += 1;
    ss.streak = 0;
  } else {
    ss.skipped += 1;
    ss.streak = 0;
  }
  // Rating change.
  const pr = state.puzzle.current ? state.puzzle.current.rating : 1500;
  const delta = _ratingDelta(
    state.puzzle.sessionRating, pr, didSolve, state.puzzle.solveMs,
  );
  state.puzzle.sessionRating = Math.max(
    400, Math.min(3000, state.puzzle.sessionRating + delta)
  );
  state.puzzle.history.unshift({
    id: state.puzzle.current ? state.puzzle.current.id : "?",
    outcome,
    rating: pr,
    delta,
    solveMs: state.puzzle.solveMs,
  });
  if (state.puzzle.history.length > 30) state.puzzle.history.length = 30;
  _savePuzzleSession();
  spawnPuzzleCelebration(outcome === "failed" || outcome === "skipped" ? "bad" : "ok");
  // In a live party match the official rating is frozen — we just push
  // the attempt over the WebSocket and let the server push the next
  // puzzle. Solo mode keeps the existing leaderboard sync.
  if (state.party.active && state.party.status === "playing") {
    sendPartyAttempt({
      puzzle_id: state.puzzle.current ? String(state.puzzle.current.id || "") : "",
      outcome: (outcome === "solved-hint") ? "solved" : outcome,
      solve_ms: state.puzzle.solveMs,
    });
  } else {
    // Server is authoritative for rating — it computes Δ and the new
    // rating from the canonical puzzle rating in its bank. We don't
    // send `delta` / `new_rating` any more (those used to be trusted,
    // which let anyone hand-edit users.json over the network). Sync
    // back from the server's response so localStorage stays in step.
    recordPuzzleAttemptOnServer({
      outcome,
      puzzle_id: state.puzzle.current ? String(state.puzzle.current.id || "") : null,
      solve_ms: state.puzzle.solveMs,
    }).then((u) => {
      if (u && typeof u === "object" && typeof u.rating === "number") {
        state.puzzle.sessionRating = u.rating;
        if (u.stats && typeof u.stats === "object") {
          if (typeof u.stats.current_streak === "number") {
            state.puzzle.sessionStats.streak = u.stats.current_streak;
          }
          if (typeof u.stats.best_streak === "number") {
            state.puzzle.sessionStats.bestStreak = Math.max(
              state.puzzle.sessionStats.bestStreak,
              u.stats.best_streak,
            );
          }
        }
        _savePuzzleSession();
        renderPuzzleStatsBar();
      }
    });
  }
  renderPuzzleUi();
  renderPuzzleStatsBar();
  renderPuzzleHistory();
}

function spawnPuzzleCelebration(kind) {
  if (!boardEl) return;
  let glyph, cls;
  if (kind === "ok")  { glyph = "✔"; cls = "drill-burst-ok"; }
  else                { glyph = "✖"; cls = "drill-burst-bad"; }
  const el = document.createElement("div");
  el.className = `drill-burst ${cls}`;
  el.textContent = glyph;
  boardEl.appendChild(el);
  setTimeout(() => el.remove(), 900);
}

function renderPuzzleStatsBar() {
  const host = document.getElementById("puzzle-stats-bar");
  if (!host) return;
  const ss = state.puzzle.sessionStats;
  // Live timer for the running puzzle, frozen solveMs once finished.
  const ms = state.puzzle.startedAt
    ? (state.puzzle.solveMs || (Date.now() - state.puzzle.startedAt))
    : 0;
  const sec = Math.max(0, Math.floor(ms / 1000));
  const tm = Math.floor(sec / 60);
  const ts = sec % 60;
  const timer = `${tm}:${String(ts).padStart(2, "0")}`;
  // Per spec: главный экран пазлов оставляет только серию + время
  // текущего пазла. Решено/Ошибки/Пропуски/Рейтинг переехали в профиль.
  host.innerHTML = `
    <div class="ps-block ps-streak">
      <span class="ps-label">Серия</span>
      <span class="ps-val ${ss.streak >= 3 ? "ok" : ""}">🔥 ${ss.streak}</span>
    </div>
    <div class="ps-divider"></div>
    <div class="ps-block ps-timer">
      <span class="ps-label">Время</span>
      <span class="ps-val" id="puzzle-timer-val">${timer}</span>
    </div>
  `;
}

function renderPuzzleHistory() {
  const host = document.getElementById("puzzle-history");
  if (!host) return;
  const items = state.puzzle.history.slice(0, 12);
  if (!items.length) { host.innerHTML = ""; return; }
  host.innerHTML = items.map((h) => {
    let cls = "h-skip", glyph = "—";
    if (h.outcome === "solved")          { cls = "h-ok";  glyph = "✓"; }
    else if (h.outcome === "solved-hint"){ cls = "h-ok";  glyph = "✓?"; }
    else if (h.outcome === "failed")     { cls = "h-bad"; glyph = "✕"; }
    return `<span class="puzzle-history-pill ${cls}" title="#${escapeHtml(h.id)} · ${h.rating}">${glyph} ${h.rating}</span>`;
  }).join("");
}

function renderPuzzleUi() {
  const card = document.getElementById("puzzle-card");
  const actions = document.getElementById("puzzle-actions");
  renderPuzzleStatsBar();
  renderPuzzleHistory();
  if (!card || !actions) return;
  const p = state.puzzle.current;
  // Idle (pre-start) screen — user just opened the puzzle tab and we
  // don't auto-load; show a single "Начать игру" button instead so
  // they explicitly opt in to the difficulty bump / rating change.
  if (!p && state.puzzle.idle) {
    card.innerHTML = `
      <div class="puzzle-start-screen">
        <h3>Готов к пазлам?</h3>
        <p class="muted">Нажми "Начать игру", чтобы загрузить первую задачу. Сложность подстроится под твой рейтинг.</p>
        <button id="btn-puzzle-start" type="button" class="puzzle-primary puzzle-start-cta">▶ Начать игру</button>
      </div>
    `;
    actions.innerHTML = "";
    const startBtn = document.getElementById("btn-puzzle-start");
    if (startBtn) startBtn.onclick = () => {
      state.puzzle.idle = false;
      loadNextPuzzle();
    };
    return;
  }
  if (!p) {
    card.innerHTML = `<div class="puzzle-empty">Загружаем задачу…</div>`;
    actions.innerHTML = "";
    return;
  }
  const sideCls = state.puzzle.side === "w" ? "side-w" : "side-b";
  const sideLetter = state.puzzle.side === "w" ? "♔" : "♚";
  const sideLabel = state.puzzle.side === "w" ? "белые" : "чёрные";
  // Feedback box. We deliberately stay minimal — chess.com doesn't
  // expose theme/progress/move-count hints, neither do we. After
  // finalization the card shows the puzzle's rating and Δ once.
  // Note: the side-to-move banner already says "Ход за <сторону>",
  // so the in-progress feedback prompts only carry the call-to-action.
  let feedback = "";
  if (state.puzzle.feedback === "solved") {
    const last = state.puzzle.history[0];
    const dt = last && last.solveMs
      ? `${(last.solveMs / 1000).toFixed(1)}s` : "";
    if (state.puzzle.hintUsed) {
      feedback = `<div class="puzzle-feedback fb-info">✓ Решено с подсказкой${dt ? ` · ${dt}` : ""}. Δ 0.</div>`;
    } else {
      feedback = `<div class="puzzle-feedback fb-solved">🏆 Решено${dt ? ` за ${dt}` : ""}. ${_lastDeltaText()}</div>`;
    }
  } else if (state.puzzle.feedback === "shown") {
    feedback = `<div class="puzzle-feedback fb-bad">✕ Задача не решена. ${_lastDeltaText()}</div>`;
  } else if (state.puzzle.hintUsed) {
    feedback = `<div class="puzzle-feedback fb-info">Подсказка: исходная клетка подсвечена.</div>`;
  } else {
    feedback = `<div class="puzzle-feedback fb-info">Найди лучший ход.</div>`;
  }
  card.innerHTML = `
    <div class="puzzle-side-banner">
      <span class="puzzle-side-icon ${sideCls}">${sideLetter}</span>
      <span class="puzzle-side-text">Ход за <b>${sideLabel}</b></span>
    </div>
    ${feedback}
  `;
  // Action buttons depend on whether we're solving or finished. In a
  // party match where we just lost our last life the server stops
  // sending us new puzzles and we shouldn't be able to hint/skip the
  // last one — replace the row with a clear "you're out" notice
  // instead. The "Смотреть матч" CTA in this notice mirrors the
  // elimination modal so the user can still hop into spectator mode
  // even after they dismissed the modal.
  const finished = !state.puzzle.active;
  const partyEliminated = state.party.active && state.party.selfEliminated;
  if (partyEliminated) {
    actions.innerHTML = `
      <div class="puzzle-eliminated muted">
        <span class="puzzle-eliminated-icon" aria-hidden="true">⚔</span>
        <span class="puzzle-eliminated-text">Вы выбыли из матча. Матч идёт, пока в живых есть хотя бы двое.</span>
        <button id="btn-puzzle-spectate" type="button" class="puzzle-secondary">Смотреть матч</button>
      </div>
    `;
    document.getElementById("btn-puzzle-spectate")?.addEventListener("click", () => {
      _partySwitchToSpectator();
    });
  } else if (finished) {
    actions.innerHTML = `
      <button id="btn-puzzle-next" type="button" class="puzzle-primary">→ Следующая</button>
    `;
  } else {
    actions.innerHTML = `
      <button id="btn-puzzle-hint" type="button" class="puzzle-secondary" ${state.puzzle.hintUsed ? "disabled" : ""}>💡 Подсказка</button>
      <button id="btn-puzzle-skip" type="button" class="puzzle-secondary">⤳ Пропустить</button>
    `;
  }
  // Wire up actions.
  const hintBtn  = document.getElementById("btn-puzzle-hint");
  const skipBtn  = document.getElementById("btn-puzzle-skip");
  const nextBtn  = document.getElementById("btn-puzzle-next");
  if (hintBtn) hintBtn.onclick = () => {
    const u = state.puzzle.moves[state.puzzle.nextIdx];
    if (u && u.length >= 4) {
      state.puzzle.hintUsed = true;
      state.bestArrow = { from: u.slice(0, 2), to: u.slice(0, 2) };
      renderBoard();
      renderPuzzleUi();
    }
  };
  if (skipBtn) skipBtn.onclick = () => {
    finalizePuzzle("skipped");
    if (state.puzzle.pendingNext) clearTimeout(state.puzzle.pendingNext);
    state.puzzle.pendingNext = setTimeout(() => {
      state.puzzle.pendingNext = null;
      loadNextPuzzle();
    }, 1100);
  };
  if (nextBtn) nextBtn.onclick = () => {
    if (state.puzzle.pendingNext) {
      clearTimeout(state.puzzle.pendingNext);
      state.puzzle.pendingNext = null;
    }
    loadNextPuzzle();
  };
}

function _lastDelta() {
  const h = state.puzzle.history[0];
  return h && typeof h.delta === "number"
    ? (h.delta > 0 ? "+" + h.delta : String(h.delta))
    : "0";
}
function _lastDeltaText() {
  const h = state.puzzle.history[0];
  if (!h || typeof h.delta !== "number") return "";
  if (h.delta > 0) return `Рейтинг +${h.delta}.`;
  if (h.delta < 0) return `Рейтинг ${h.delta}.`;
  return "";
}

async function renderOpeningExplorer(fen) {
  const host = document.getElementById("opening-explorer");
  if (!host) return;
  if (!fen) { host.innerHTML = ""; return; }
  // Only show for positions in the first 20 moves.
  const fullmove = parseInt((fen.split(" ")[5] || "1"), 10);
  if (fullmove > 20) { host.innerHTML = ""; return; }
  try {
    const r = await api(`/api/opening/explorer?fen=${encodeURIComponent(fen)}&limit=5`);
    const moves = r.moves || [];
    if (!moves.length) { host.innerHTML = ""; return; }
    const rows = moves.map((m) => `
      <tr>
        <td class="oe-san">${escapeHtml(m.san)}</td>
        <td class="oe-total">${m.total.toLocaleString("ru-RU")}</td>
        <td>
          <div class="pct-bar" title="Белые ${m.white_pct}% / Ничьи ${m.draw_pct}% / Чёрные ${m.black_pct}%">
            <span class="pct-w" style="width:${m.white_pct}%"></span>
            <span class="pct-d" style="width:${m.draw_pct}%"></span>
            <span class="pct-b" style="width:${m.black_pct}%"></span>
          </div>
        </td>
      </tr>`).join("");
    host.innerHTML = `<h3>Дебютный обзор (Lichess Masters)</h3>
      <table>
        <thead><tr><th>Ход</th><th>Партии</th><th>Результат</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch { host.innerHTML = ""; }
}

// Parse per-ply clock annotations from chess.com / lichess PGN comments
// of the form `{[%clk H:MM:SS(.ms)?]}`. Returns a list aligned to
// moves_uci where index i is the clock REMAINING for the side that just
// played ply i+1 (0-indexed: 0 = white's first move). Missing entries
// are stored as null. Returns [] if PGN has no clock annotations.
function parsePgnClocks(pgnText) {
  if (typeof pgnText !== "string" || pgnText.length === 0) return [];
  // We don't need to strip headers; %clk only appears in move text.
  const re = /\{[^}]*?\[%clk\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\]/g;
  const out = [];
  let m;
  while ((m = re.exec(pgnText)) !== null) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const c = m[3] != null ? parseInt(m[3], 10) : null;
    // PGN [%clk] is H:MM:SS or M:SS — detect by presence of seconds group.
    const totalSec = c != null
      ? a * 3600 + b * 60 + c
      : a * 60 + b;
    out.push(totalSec);
  }
  return out;
}

// Format remaining seconds as the chess.com-style "M:SS" (no hours unless
// >= 1h). Ex: 90 → "1:30", 3600 → "1:00:00".
function fmtClock(sec) {
  if (sec == null || !Number.isFinite(sec)) return "";
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

// Look up the most recent clock value for `side` ("w" / "b") at the given
// activeIdx (0-based ply index, or -1 for "no moves played yet"). White's
// plies are even (0, 2, 4...), black's are odd. Returns null if no clock
// entry exists for that side up to that point.
function clockForSideAt(clocks, side, activeIdx) {
  if (!clocks || clocks.length === 0) return null;
  const sideParity = side === "w" ? 0 : 1;
  // Walk backwards from activeIdx to find the most recent ply that this
  // side played (matching parity) and that has a clock entry.
  for (let i = activeIdx; i >= 0; i -= 1) {
    if (i % 2 !== sideParity) continue;
    if (clocks[i] != null) return clocks[i];
  }
  return null;
}

// Material values for captured-piece score tally.
const PIECE_POINTS = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
// Standard starting count of each piece per side.
const START_PIECE_COUNTS = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
// Render order matches chess.com strip: pawns → knights → bishops → rooks → queens.
const CAPTURE_ORDER = ["p", "n", "b", "r", "q"];

// Compute pieces missing from the current state.board for each side.
// Returns { white: { p: n, ... }, black: { p: n, ... }, score: signedDiff }.
// "white" object lists BLACK pieces captured BY white; vice-versa for "black".
function _computeCaptured() {
  const counts = { white: {}, black: {} };
  for (const k of CAPTURE_ORDER) { counts.white[k] = 0; counts.black[k] = 0; }
  // state.board entries are FEN-letters: uppercase white, lowercase black.
  // Count what's currently on the board for each side.
  const onBoard = { white: {}, black: {} };
  for (const k of CAPTURE_ORDER) { onBoard.white[k] = 0; onBoard.black[k] = 0; }
  for (const piece of state.board) {
    if (!piece) continue;
    const lower = piece.toLowerCase();
    if (lower === "k") continue;
    if (piece === piece.toUpperCase()) onBoard.white[lower] = (onBoard.white[lower] || 0) + 1;
    else onBoard.black[lower] = (onBoard.black[lower] || 0) + 1;
  }
  // Captured BY white = (start count of black piece) − (currently on board).
  for (const k of CAPTURE_ORDER) {
    counts.white[k] = Math.max(0, START_PIECE_COUNTS[k] - onBoard.black[k]);
    counts.black[k] = Math.max(0, START_PIECE_COUNTS[k] - onBoard.white[k]);
  }
  // Score = sum(values captured by white) − sum(values captured by black).
  let scoreWhite = 0, scoreBlack = 0;
  for (const k of CAPTURE_ORDER) {
    scoreWhite += counts.white[k] * PIECE_POINTS[k];
    scoreBlack += counts.black[k] * PIECE_POINTS[k];
  }
  return { counts, score: scoreWhite - scoreBlack };
}

// Render captured-pieces row + optional "+N" advantage.
// `forSide` is "white" or "black" — the side that captured them.
function _renderCapturedRow(forSide, captured, advantage) {
  const parts = [];
  // Captured pieces are the OPPONENT's piece colour.
  // FEN: uppercase = white piece, lowercase = black piece.
  for (const k of CAPTURE_ORDER) {
    const n = captured[forSide][k] || 0;
    if (n <= 0) continue;
    const pieceChar = forSide === "white" ? k : k.toUpperCase();
    for (let i = 0; i < n; i += 1) {
      parts.push(
        `<img class="cap-piece" src="${pieceSvgUrl(pieceChar)}" alt="${k}">`
      );
    }
  }
  // advantage > 0 means *this* side leads in material.
  const adv = advantage > 0 ? `<span class="cap-adv">+${advantage}</span>` : "";
  return `<span class="cap-row">${parts.join("")}${adv}</span>`;
}

function renderPlayerStrips() {
  const top = document.getElementById("player-top");
  const bot = document.getElementById("player-bottom");
  if (!top || !bot) return;
  const game = review.game;
  if (!game) {
    top.hidden = true;
    bot.hidden = true;
    top.innerHTML = "";
    bot.innerHTML = "";
    return;
  }
  const h = game.headers || {};
  const whiteName = (h.White || "Белые").trim() || "Белые";
  const blackName = (h.Black || "Чёрные").trim() || "Чёрные";
  const whiteElo = (h.WhiteElo || "").trim();
  const blackElo = (h.BlackElo || "").trim();
  const whiteAvatar = h.WhiteAvatar || "";
  const blackAvatar = h.BlackAvatar || "";
  const cap = _computeCaptured();
  const advWhite = cap.score > 0 ? cap.score : 0;
  const advBlack = cap.score < 0 ? -cap.score : 0;
  const clocks = review.clocks || [];
  const renderSide = (color, name, elo, avatar) => {
    const meta = elo ? `<span class="player-meta">${elo}</span>` : "";
    const avatarHtml = avatar
      ? `<img class="player-avatar" src="${escapeHtml(avatar)}" alt="" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'player-disc ${color}'}))">`
      : `<span class="player-disc ${color}"></span>`;
    const adv = color === "white" ? advWhite : advBlack;
    const sideKey = color === "white" ? "w" : "b";
    const cSec = clockForSideAt(clocks, sideKey, review.activeIdx);
    const clockHtml = cSec != null
      ? `<span class="player-clock">${fmtClock(cSec)}</span>`
      : "";
    return `
      ${avatarHtml}
      <span class="player-name">${escapeHtml(name)}</span>
      ${meta}
      ${_renderCapturedRow(color, cap.counts, adv)}
      ${clockHtml}
    `;
  };
  // Visual top of board = side opposite to the bottom-of-screen player.
  // When unflipped, white sits at the bottom; flipping swaps the strips.
  const bottomColor = state.flipped ? "black" : "white";
  const topColor    = state.flipped ? "white" : "black";
  const bottomName  = bottomColor === "white" ? whiteName : blackName;
  const bottomElo   = bottomColor === "white" ? whiteElo  : blackElo;
  const bottomAvatar = bottomColor === "white" ? whiteAvatar : blackAvatar;
  const topName     = topColor    === "white" ? whiteName : blackName;
  const topElo      = topColor    === "white" ? whiteElo  : blackElo;
  const topAvatar   = topColor    === "white" ? whiteAvatar : blackAvatar;
  top.innerHTML = renderSide(topColor, topName, topElo, topAvatar);
  bot.innerHTML = renderSide(bottomColor, bottomName, bottomElo, bottomAvatar);
  top.hidden = false;
  bot.hidden = false;
}

function renderReviewMoves() {
  const ol = document.getElementById("review-moves");
  ol.innerHTML = "";
  const moves = review.analysis ? review.analysis.moves : null;
  const game = review.game;
  if (!game) return;
  const list = moves || game.moves_uci.map((u, i) => ({
    ply: i + 1, side: i % 2 === 0 ? "w" : "b",
    move_uci: u, move_san: u, classification: "", note: "",
    eval_after_cp: 0,
  }));
  list.forEach((m, idx) => {
    const li = document.createElement("li");
    li.className = `cls-${m.classification || "good"}`;
    if (idx === review.activeIdx) li.classList.add("is-active");
    if (review.filter.size > 0 && !review.filter.has(`${m.classification}:${m.side}`)) {
      li.classList.add("is-hidden");
    }
    const moveNum = Math.ceil(m.ply / 2) + ".";
    const dots = m.side === "b" ? "…" : "";
    const coachHtml = (m.coach && m.coach.length)
      ? `<span class="coach">${m.coach.map(escapeHtml).join(" · ")}</span>` : "";
    li.innerHTML = `
      <span class="ply">${moveNum}${dots}</span>
      <span class="icon">${REVIEW_ICONS[m.classification] || ""}</span>
      <span class="san">${m.move_san}</span>
      <span class="note">${m.note || ""}${coachHtml}</span>
      <span class="eval">${moves ? fmtCp(m.eval_after_cp) : ""}</span>
    `;
    li.addEventListener("click", () => {
      jumpToReviewIdx(idx);
    });
    ol.appendChild(li);
  });
  refreshNavButtons();
}

function jumpToReviewIdx(idx, opts) {
  const game = review.game;
  if (!game) return;
  const playSound = !opts || opts.playSound !== false;
  const moves = review.analysis ? review.analysis.moves : null;
  if (playSound && idx >= 0) {
    // Sound is decided by the move we're landing ON. With analysis we
    // get SAN directly; without, fall back to a generic move tap.
    if (moves && moves[idx]) {
      const m = moves[idx];
      const isOwn = review.userSide ? (m.side === review.userSide) : true;
      playMoveSoundForSan(m.move_san, { isOwn });
    } else {
      playMoveSound();
    }
  }
  // idx == -1 means starting position; idx >= 0 means after that ply.
  review.activeIdx = idx;
  let fen, lastMove = null;
  if (idx < 0) {
    fen = game.starting_fen;
  } else if (moves) {
    const m = moves[idx];
    fen = m.fen_after;
    lastMove = m.move_uci ? { from: m.move_uci.slice(0, 2), to: m.move_uci.slice(2, 4) } : null;
  } else {
    // No analysis yet: replay PGN moves up to idx using chess.js if present.
    fen = game.starting_fen;
    if (typeof Chess === "function") {
      try {
        const c = new Chess(fen);
        for (let i = 0; i <= idx; i++) {
          const u = game.moves_uci[i];
          c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.slice(4) || undefined });
        }
        fen = c.fen();
        const u = game.moves_uci[idx];
        lastMove = { from: u.slice(0, 2), to: u.slice(2, 4) };
      } catch { /* ignore */ }
    }
  }
  try {
    loadFen(fen);
    state.lastMove = lastMove;
    if (idx >= 0 && moves) {
      const m = moves[idx];
      state.reviewBadge = lastMove ? { square: lastMove.to, classification: m.classification } : null;
      state.bestArrow = m.best_move_uci
        ? { from: m.best_move_uci.slice(0, 2), to: m.best_move_uci.slice(2, 4) }
        : null;
      // Only show PV arrows when the played move ≠ best move
      // (otherwise the green arrow already sits on the played square).
      state.bestPv = (m.move_uci !== m.best_move_uci && Array.isArray(m.best_pv_uci))
        ? m.best_pv_uci
        : null;
    } else {
      state.reviewBadge = null;
      state.bestArrow = null;
      state.bestPv = null;
    }
    renderBoard();
    renderBoardHint();
    renderPlayerStrips();
    // Refresh opening explorer for the current position (fire-and-forget).
    renderOpeningExplorer(fen);
  } catch { /* ignore */ }
  // Update active list highlighting without full re-render of summary.
  document.querySelectorAll("#review-moves li").forEach((el, i) => {
    el.classList.toggle("is-active", i === idx);
  });
  refreshNavButtons();
  refreshEvalBarFromActive();
  refreshGraphCursorFromActive();
}

function refreshGraphCursorFromActive() {
  const moves = review.analysis ? review.analysis.moves : null;
  const svg = document.getElementById("review-graph");
  if (!moves || !svg) return;
  const cursor = svg.querySelector("#graph-cursor-line");
  if (!cursor) return;
  const idx = review.activeIdx;
  if (idx < 0) {
    cursor.style.display = "none";
    return;
  }
  const x = ((idx + 1) / moves.length) * GRAPH_W;
  cursor.style.display = "";
  cursor.setAttribute("x1", x.toFixed(2));
  cursor.setAttribute("x2", x.toFixed(2));
}

function renderBoardHint() {
  const host = document.getElementById("board-hint");
  if (!host) return;
  const moves = review.analysis ? review.analysis.moves : null;
  if (!moves || review.activeIdx < 0) {
    host.textContent = "";
    return;
  }
  const m = moves[review.activeIdx];
  if (!m || !m.best_move_san) { host.textContent = ""; return; }
  const sideLabel = m.side === "w" ? "Белые" : "Чёрные";
  const playedSan = m.move_san;
  const bestSan = m.best_move_san || "";
  const playedEval = fmtCp(m.eval_after_cp);
  const bestEval = fmtCp(m.eval_before_cp);
  const showPlayedEval = !/[+#]$/.test(playedSan);
  const showBestEval = !/[+#]$/.test(bestSan);
  let main;
  if (m.move_uci === m.best_move_uci) {
    main = `<span class="label">${sideLabel} сыграли лучший ход:</span><span class="san">${playedSan}</span>${showPlayedEval ? `<span class="eval">${playedEval}</span>` : ""}`;
  } else {
    const playedTail = showPlayedEval ? ` (${playedEval})` : "";
    main = `<span class="label">${sideLabel} сыграли ${playedSan}${playedTail}. Лучше было:</span><span class="san">${bestSan}</span>${showBestEval ? `<span class="eval">${bestEval}</span>` : ""}`;
  }
  // Show the engine's PV line (first ≤5 SAN moves) when we didn't play
  // the top move — gives the user a glimpse of "what was right and why".
  let pvLine = "";
  if (
    m.best_pv_san
    && m.best_pv_san.length >= 2
    && m.move_uci !== m.best_move_uci
  ) {
    const lineLen = _clampBestLine(userSettings.bestLineLength);
    // PV[0] is played by the side whose move is being analysed (m.side);
    // PV[i] alternates from there. Colour each SAN by which side plays it
    // so the user can tell white/black moves apart at a glance.
    const sansHtml = m.best_pv_san.slice(0, lineLen)
      .map((s, i) => {
        const sideOfPly = (i % 2 === 0) ? m.side : (m.side === "w" ? "b" : "w");
        return `<span class="pv-san pv-san-${sideOfPly}">${escapeHtml(s)}</span>`;
      }).join("");
    pvLine = `<div class="pv-line"><span class="pv-label">Лучшая линия:</span>${sansHtml}</div>`;
  }
  // Hardcoded coach panel — a deterministic, chess.com-flavoured
  // explanation of why the move earned its classification. We don't
  // talk to any external service; everything is generated locally
  // from the engine numbers we already have.
  const coachPanel = renderHardcodedCoachPanel(m);
  host.innerHTML = main + pvLine + coachPanel;
}

// ---------- Hardcoded analysis coach (no AI) ----------
//
// `renderHardcodedCoachPanel` emits a chess.com-style explanation of a
// single ply using only data we already have (classification, eval
// delta, best move, side). The previous build streamed text from
// Ollama; that's gone, so we lean on a wide pool of canned phrases
// keyed by classification + situation. Each ply renders identically
// across re-paints because we hash on `ply` to pick a phrase variant.

// Quick stable PRNG — same input always returns the same value, so the
// same ply always shows the same canned phrase even after re-renders.
function _coachPick(arr, key) {
  if (!arr || !arr.length) return "";
  let h = 2166136261 >>> 0;
  const s = String(key);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return arr[h % arr.length];
}

// Verdict text for the bold headline (per classification, several
// variants). Chess.com-flavoured and short enough to fit one line.
const COACH_HEADLINES = {
  brilliant: [
    "Бриллиантовый ход.",
    "Бриллиант — это жертва!",
    "Редкая комбинация, бриллиант.",
    "Блестяще: отдаёшь материал ради победы.",
  ],
  great: [
    "Великолепный ход.",
    "Сильнейший ход, найти непросто.",
    "Грейт! Находка уровня мастера.",
    "Отличный выбор — видят единицы.",
  ],
  best: [
    "Лучший ход по Stockfish.",
    "Точно первая линия движка.",
    "Без вариантов, сильнейшее.",
    "Оптимально — движок брал бы то же.",
  ],
  excellent: [
    "Отличный ход.",
    "На уровне движка — практически без потерь.",
    "Сильный выбор, разница мизерная.",
    "Практически идеальный ход.",
  ],
  good: [
    "Хороший ход.",
    "Нормальный солидный ход.",
    "Разумный выбор.",
    "Без претензий — надёжно.",
  ],
  book: [
    "Точно по теории.",
    "Книжный ход — это дебют.",
    "Работает теория.",
    "Дебютная линия — по книге.",
  ],
  forced: [
    "Единственный разумный ход.",
    "Вынужденно — выбора не было.",
    "Иначе позиция рушится.",
    "Ситуация диктовала этот ход.",
  ],
  inaccuracy: [
    "Неточность.",
    "Стоит оценку на немного хуже.",
    "Не лучший выбор, но не провал.",
    "Можно было точнее.",
  ],
  mistake: [
    "Ошибка.",
    "Оценка заметно ухудшилась.",
    "Промах — было сильнее.",
    "Серьёзная ошибка.",
  ],
  blunder: [
    "Грубая ошибка.",
    "Зевок — позиция развалилась.",
    "Бландер! Соперник получил подарок.",
    "Критический промах.",
  ],
  miss: [
    "Упускаешь выигрыш.",
    "Проходит мимо сильнейшего хода.",
    "Мисс — была выигрывающая возможность.",
    "Перевес в руках растаял.",
  ],
};

// Idea text (sub-line, italicised). Same key -> 6+ variants per
// classification. We pick by ply hash so it's stable.
const COACH_IDEAS = {
  brilliant: [
    "Ты отдаёшь материал ради решающей атаки — и это работает.",
    "Жертва вскрывает линии к королю и окупается матом или перевесом.",
    "Цель — получить инициативу, которую материальный размен не покажет.",
    "Расчёт на несколько ходов: инициатива > материала.",
    "Неочевидная жертва, которую не видят 99% игроков.",
    "Связь и открытая диагональ или вертикаль — движок видит это в глубине.",
  ],
  great: [
    "Это единственный ход, держащий перевес — остальные проигрывают инициативу.",
    "Точно выбрана редкая линия, которую трудно увидеть.",
    "Сильнейший ресурс в позиции, решающий исход.",
    "Этот ход из серии «видим на 5 ходов вперёд».",
    "Остальные приличные ходы теряют оценку — этот держит.",
    "Отличный расчёт: перевес сохранён, инициатива растёт.",
  ],
  best: [
    "Движок выбрал бы то же самое — тебя не выбьешь из лучшей линии.",
    "Идеальный выбор — разница с альтернативами ощутима.",
    "Ты сыграл лучший ход в позиции. Продолжай в том же духе.",
    "Сильнейшее продолжение — прямо из первой линии Stockfish.",
    "Точно по движку — хорошая привычка.",
    "Никакой ход рядом не приближается к этой оценке.",
  ],
  excellent: [
    "Очень хороший ход, практически на уровне лучшего.",
    "Потеря в оценке мизерная, продолжай в таком же духе.",
    "Неплохо разобрался в позиции — выбор почти оптимальный.",
    "Разница с топ-ходом символическая.",
    "Это «вторая линия движка» — вполне достойно.",
    "Проверено: ход держит оценку практически на максимуме.",
  ],
  good: [
    "Нормальный принципиальный ход — позиция развивается.",
    "Разумный выбор без явных минусов.",
    "Движок бы поиграл ярче, но оценка практически не пострадала.",
    "Солидный ход, держит рисунок игры.",
    "Без блеска, но надёжно.",
    "Ничего плохого — продолжаем.",
  ],
  book: [
    "Это ещё теория, ход из дебютных книг.",
    "Работает подготовка: всё по линии.",
    "Теоретическое продолжение — это плюс к времени на часах.",
    "Аккуратно по дебютной базе.",
    "Общепринятая линия — хорошо известна.",
    "Дебют идёт по рельсам.",
  ],
  forced: [
    "Альтернативы резко плохи, выбора не было.",
    "Единственный ход, который не проигрывает фигуру или партию.",
    "Позиция диктует этот ответ — иначе всё разваливается.",
    "Героический спасительный ход в одном варианте.",
    "Движок не оставил вариантов.",
    "Иначе — сразу решающий перевес соперника.",
  ],
  inaccuracy: [
    "Небольшая неточность — видимо, было более активное продолжение.",
    "Стоит поработать над выбором хода в этой структуре.",
    "Не критично, но инициатива притормозилась.",
    "Небольшой минус от лучшего хода.",
    "Просто не попал в топ-1; позиция всё ещё в порядке.",
    "Неплохо, но было решение ярче.",
  ],
  mistake: [
    "Оценка ухудшилась ощутимо — соперник получил фору.",
    "Было заметно сильнее продолжение.",
    "Промах — разбери вариант внимательно.",
    "Позиция стала проблемнее — выигрыш уже сложнее.",
    "Не фатально, но инициатива потеряна.",
    "Стоило вспомнить принцип «сначала безопасность короля» — или «вражебных фигур в ряд».",
  ],
  blunder: [
    "Грубая ошибка: соперник получает выигрывающую позицию.",
    "Зевок материала или решающих линий.",
    "Бландер — стоит разобрать эту позицию в тренировке.",
    "Проигрывают фигуру или качество — видят в варианте.",
    "Перевес резко ушёл к сопернику.",
    "Стоит всегда проверять «что было бы, если я этот ход не играю?» — это отличный фильтр бландеров.",
  ],
  miss: [
    "Была выигрывающая идея — находится в лучшей линии движка.",
    "Мисс — не увидел решающий ресурс в позиции.",
    "Перевес был под рукой, но выбрано другое.",
    "Из-за этого хода позиция вернулась к равенству.",
    "Движок рекомендует другой замысел — была форсированная линия.",
    "Атака остановилась на полуходе — поиск форсированных вариантов важен.",
  ],
};

// Build the canned coach text for a single move object.
function buildHardcodedCoach(m) {
  if (!m) return { headline: "", idea: "", evalText: "", bestSan: "", tone: "" };
  const cls = m.classification || "good";
  const headline = _coachPick(COACH_HEADLINES[cls] || COACH_HEADLINES.good, `h:${cls}:${m.ply}`);
  const idea = _coachPick(COACH_IDEAS[cls] || COACH_IDEAS.good, `i:${cls}:${m.ply}`);
  let tone = "info";
  if (["brilliant", "great", "best", "excellent", "good", "book"].includes(cls)) tone = "good";
  else if (cls === "forced") tone = "info";
  else if (cls === "inaccuracy") tone = "warn";
  else tone = "bad";
  // Eval line — prefer m.eval_after_cp from white's POV when known.
  let evalText = "";
  if (Number.isFinite(m.eval_after_cp)) {
    const cp = m.eval_after_cp;
    if (cp >= 99000) evalText = `Оценка: M${100000 - cp}`;
    else if (cp <= -99000) evalText = `Оценка: −M${cp + 100000}`;
    else evalText = `Оценка: ${(cp / 100).toFixed(2)}`;
  }
  const bestSan = m.best_move_san || "";
  return { headline, idea, evalText, bestSan, tone };
}

function renderHardcodedCoachPanel(m) {
  const data = buildHardcodedCoach(m);
  if (!data.headline && !data.idea) return "";
  const toneCls = data.tone ? ` opening-ai-verdict-${data.tone}` : "";
  const evalLine = (data.evalText || data.bestSan)
    ? `<div class="opening-ai-evalrow">${
        data.evalText ? `<span class="opening-ai-eval">${escapeHtml(data.evalText)}</span>` : ""
      }${
        data.bestSan ? `<span class="opening-ai-best">Лучше: <code>${escapeHtml(data.bestSan)}</code></span>` : ""
      }</div>`
    : "";
  return `
    <div class="opening-ai-panel review-ai-panel">
      <div class="opening-ai-header">
        <strong>Тренер</strong>
      </div>
      <div class="opening-ai-text">
        ${data.headline ? `<div class="opening-ai-verdict${toneCls}">${escapeHtml(data.headline)}</div>` : ""}
        ${evalLine}
        ${data.idea ? `<div class="opening-ai-idea">${escapeHtml(data.idea)}</div>` : ""}
      </div>
    </div>
  `;
}

// ---------- Legacy AI coach — hardcoded no-op shim ----------
//
// All callers below are kept (some still hand-wired to the opening UI)
// but the implementations are now stubs that never make a network
// request. Removing the names entirely would require touching dozens
// of callsites; the shim preserves binary compatibility while doing
// nothing.

function _renderAnalysisAiCoachPanel(m) {
  return renderHardcodedCoachPanel(m);
}

function _renderAnalysisAiCoachPanel_unused(m) {
  const ai = review.aiCoach;
  const ply = review.activeIdx;
  const cls = m && m.classification;
  const worthy = cls && REVIEW_AI_WORTHY.has(cls);
  const cached = ply >= 0 ? ai.cache[ply] : "";
  const isStreaming = ai.streaming && ai.activeReqPly === ply;
  let statusBadge = "";
  let helpText = "";
  if (ai.status === null || ai.status === "checking") {
    statusBadge = `<span class="opening-ai-badge opening-ai-badge-checking">проверяем Ollama…</span>`;
  } else if (ai.status === true) {
    statusBadge = `<span class="opening-ai-badge opening-ai-badge-ok">Ollama on · ${escapeHtml(ai.model || "")}</span>`;
  } else {
    statusBadge = `<span class="opening-ai-badge opening-ai-badge-off">Ollama off</span>`;
    helpText = `
      <div class="opening-ai-help muted">
        Запусти локально: <code>ollama serve</code> и поставь модель
        <code>ollama pull qwen2.5:7b</code>. Можно сменить через
        <code>CHESS_OLLAMA_MODEL</code>.
      </div>`;
  }
  const sfBadge = ai.stockfishRunning
    ? `<span class="opening-ai-badge opening-ai-badge-sf">Stockfish 18 on</span>`
    : `<span class="opening-ai-badge opening-ai-badge-sf-off">Stockfish off</span>`;
  // Display priority: streaming buffer → cached text → empty placeholder.
  // Hybrid coach output uses the same line-prefixed sections as the
  // Opening Trainer: ВЕРДИКТ / ТОН / ОЦЕНКА / ЛУЧШИЙ ХОД / ИДЕЯ. We
  // reuse `_formatCoachText` to parse it and render 3 visual sections
  // (big bold tone-coloured headline → muted eval row → italic idea).
  // The previous "💡 m.coach.join(' · ')" placeholder used English
  // piece names from `chess.piece_name(...)` and confused users — it
  // is gone. The user clicks the button to get a real verdict.
  const btnDisabled = isStreaming ? "disabled" : "";
  const btnLabel = isStreaming
    ? "Тренер думает…"
    : (cached ? "🧠 Перезапросить" : "🧠 Объяснить от тренера");
  let textBlock;
  if (ai.error && ai.activeReqPly === ply) {
    textBlock = `<div class="opening-ai-text is-error">${escapeHtml(ai.error)}</div>`;
  } else if (isStreaming || cached) {
    const raw = isStreaming ? (ai.text || "") : (cached || "");
    const formatted = _formatCoachText(raw);
    const tone = _verdictTone(formatted.headline, formatted.tone);
    const toneCls = tone ? ` opening-ai-verdict-${tone}` : "";
    const evalLine = (formatted.evalText || formatted.bestSan)
      ? `<div class="opening-ai-evalrow">${
          formatted.evalText ? `<span class="opening-ai-eval">${escapeHtml(formatted.evalText)}</span>` : ""
        }${
          formatted.bestSan ? `<span class="opening-ai-best">Лучше: <code>${escapeHtml(formatted.bestSan)}</code></span>` : ""
        }</div>`
      : "";
    const ideaLine = formatted.idea
      ? `<div class="opening-ai-idea">${escapeHtml(formatted.idea)}</div>`
      : (isStreaming ? `<div class="opening-ai-idea muted">…</div>` : "");
    if (formatted.headline || formatted.evalText || formatted.idea) {
      textBlock = `
        <div class="opening-ai-text">
          ${formatted.headline ? `<div class="opening-ai-verdict${toneCls}">${escapeHtml(formatted.headline)}</div>` : ""}
          ${evalLine}
          ${ideaLine}
        </div>`;
    } else {
      textBlock = `<div class="opening-ai-text muted">${isStreaming ? "Тренер думает…" : ""}</div>`;
    }
  } else {
    const placeholder = worthy
      ? "Жми «Объяснить от тренера» — Stockfish даст вердикт, ИИ напишет идею одной фразой."
      : "Ход неплохой — спроси у тренера, если хочешь подробнее.";
    textBlock = `<div class="opening-ai-text muted">${escapeHtml(placeholder)}</div>`;
  }
  return `
    <div class="opening-ai-panel review-ai-panel">
      <div class="opening-ai-header">
        <strong>AI-тренер</strong>
        ${statusBadge}
        ${sfBadge}
      </div>
      <div class="opening-ai-actions">
        <button id="btn-review-ai-coach" type="button" class="puzzle-secondary" ${btnDisabled}>${btnLabel}</button>
        <button id="btn-review-ai-recheck" type="button" class="puzzle-secondary" title="Переподключиться к Ollama">↻</button>
      </div>
      ${textBlock}
      ${helpText}
    </div>
  `;
}

function _attachAnalysisAiCoachHandlers() {
  const askBtn = document.getElementById("btn-review-ai-coach");
  if (askBtn) askBtn.onclick = () => requestAnalysisCoach();
  const recheck = document.getElementById("btn-review-ai-recheck");
  if (recheck) recheck.onclick = () => _probeAnalysisCoach();
}

async function _probeAnalysisCoach() {
  review.aiCoach.status = "checking";
  try {
    const r = await api(`/api/analysis/coach/status`);
    review.aiCoach.status = !!(r && r.available);
    review.aiCoach.model = (r && r.model) || "";
    review.aiCoach.baseUrl = (r && r.base_url) || "";
    review.aiCoach.installedModels = (r && r.installed_models) || [];
    review.aiCoach.stockfishRunning = !!(r && r.stockfish_running);
  } catch (_e) {
    review.aiCoach.status = false;
  }
  // Re-render only the board hint to refresh the badge — avoid resetting
  // anything else in the Game Review pane while the user is reading it.
  renderBoardHint();
}

async function requestAnalysisCoach() {
  const moves = review.analysis ? review.analysis.moves : null;
  const idx = review.activeIdx;
  if (!moves || idx < 0) return;
  const m = moves[idx];
  if (!m) return;
  const ai = review.aiCoach;
  if (ai.streaming) return;
  ai.streaming = true;
  ai.text = "";
  ai.error = "";
  ai.activeReqPly = idx;
  // Drop any previous cached answer for this ply so "Перезапросить" works.
  delete ai.cache[idx];
  renderBoardHint();
  const headers = (review.game && review.game.headers) || {};
  const safeHeaders = {};
  for (const k of ["White", "Black", "WhiteElo", "BlackElo", "Event", "Date"]) {
    if (headers[k]) safeHeaders[k] = String(headers[k]);
  }
  try {
    const resp = await fetch(`/api/analysis/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fen_before: m.fen_before,
        fen_after: m.fen_after,
        move_san: m.move_san,
        best_move_san: m.best_move_san || null,
        classification: m.classification,
        eval_before_cp: m.eval_before_cp,
        eval_after_cp: m.eval_after_cp,
        side: m.side,
        ply: m.ply,
        best_pv_san: (m.best_pv_san || []).slice(0, 12),
        played_pv_san: [],
        coach_hints: (m.coach || []).slice(0, 6),
        headers: safeHeaders,
        locale: "ru",
      }),
    });
    if (!resp.ok || !resp.body) {
      ai.error = `Ошибка тренера: HTTP ${resp.status}`;
      ai.streaming = false;
      ai.activeReqPly = -1;
      renderBoardHint();
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let pendingRaf = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Bail out if the user already navigated away from this ply — we
      // don't want to scribble the late chunks over a different move.
      if (review.activeIdx !== idx) {
        try { await reader.cancel(); } catch (_e) { /* ignore */ }
        break;
      }
      if (value && value.length) {
        ai.text += decoder.decode(value, { stream: true });
        if (!pendingRaf) {
          pendingRaf = true;
          requestAnimationFrame(() => {
            pendingRaf = false;
            const host = document.querySelector(".review-ai-panel .opening-ai-text");
            if (host) host.textContent = ai.text;
          });
        }
      }
    }
    ai.text += decoder.decode();
    ai.streaming = false;
    if (review.activeIdx === idx) {
      ai.cache[idx] = ai.text;
    }
    ai.activeReqPly = -1;
    renderBoardHint();
  } catch (e) {
    ai.streaming = false;
    ai.activeReqPly = -1;
    ai.error = `Сеть/тренер: ${(e && e.message) || e}`;
    renderBoardHint();
  }
}

function refreshNavButtons() {
  const game = review.game;
  const total = game ? game.moves_uci.length : 0;
  const idx = review.activeIdx;
  const setDisabled = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.disabled = val;
  };
  setDisabled("nav-first", !game || idx < 0);
  setDisabled("nav-prev", !game || idx < 0);
  setDisabled("nav-next", !game || idx >= total - 1);
  setDisabled("nav-last", !game || idx >= total - 1);
  setDisabled("nav-play", !game || total === 0);
  // Stop autoplay if it ran past the end.
  if (review.autoplayId && (!game || idx >= total - 1)) stopAutoplay();
}

// Auto-step: every 800ms call nav-next while there are remaining moves.
const PLAY_ICON_PATH = "M20.5 12.8L7.77 21.53C6.5 22.43 6 22.16 6 20.6V3.32999C6 1.79999 6.5 1.52999 7.77 2.42999L20.5 11.2C21.33 11.77 21.33 12.23 20.5 12.8Z";
const PAUSE_ICON_PATH = "M17.33 22H16.66C14.66 22 13.99 21.33 13.99 19.33V4.65999C13.99 2.65999 14.66 1.98999 16.66 1.98999H17.33C19.33 1.98999 20 2.65999 20 4.65999V19.33C20 21.33 19.33 22 17.33 22ZM7.32999 22H6.65999C4.65999 22 3.98999 21.33 3.98999 19.33V4.65999C3.98999 2.65999 4.65999 1.98999 6.65999 1.98999H7.32999C9.32999 1.98999 9.99999 2.65999 9.99999 4.65999V19.33C9.99999 21.33 9.32999 22 7.32999 22Z";

function setPlayButtonIcon(playing) {
  const btn = document.getElementById("nav-play");
  if (!btn) return;
  btn.dataset.playing = playing ? "true" : "false";
  btn.title = playing ? "Пауза" : "Авто-проигрывание";
  const path = btn.querySelector("svg path");
  if (path) path.setAttribute("d", playing ? PAUSE_ICON_PATH : PLAY_ICON_PATH);
}

function stopAutoplay() {
  if (review.autoplayId) {
    clearInterval(review.autoplayId);
    review.autoplayId = null;
  }
  setPlayButtonIcon(false);
}

function startAutoplay() {
  if (review.autoplayId) return;
  setPlayButtonIcon(true);
  review.autoplayId = setInterval(() => {
    const total = review.game ? review.game.moves_uci.length : 0;
    if (!review.game || review.activeIdx >= total - 1) {
      stopAutoplay();
      return;
    }
    jumpToReviewIdx(review.activeIdx + 1);
  }, 800);
}

document.getElementById("nav-first").addEventListener("click", () => {
  stopAutoplay();
  // No move sound when jumping to the very start, per UX spec.
  jumpToReviewIdx(-1, { playSound: false });
});
document.getElementById("nav-prev").addEventListener("click", () => {
  stopAutoplay();
  if (review.activeIdx > -1) jumpToReviewIdx(review.activeIdx - 1);
});
document.getElementById("nav-next").addEventListener("click", () => {
  stopAutoplay();
  const total = review.game ? review.game.moves_uci.length : 0;
  if (review.activeIdx < total - 1) jumpToReviewIdx(review.activeIdx + 1);
});
document.getElementById("nav-last").addEventListener("click", () => {
  stopAutoplay();
  if (review.game) jumpToReviewIdx(review.game.moves_uci.length - 1);
});
document.getElementById("nav-play").addEventListener("click", () => {
  if (review.autoplayId) stopAutoplay();
  else startAutoplay();
});

// ---------- User / Profile / Leaderboard ----------

const AVATAR_CHOICES = [
  "♟", "♞", "♝", "♜", "♛", "♚",
  "🦊", "🐺", "🐯", "🦁", "🐼", "🐨",
  "🐉", "🦄", "🐢", "🦅", "🦉", "🐧",
  "🤖", "👾", "👻", "🎯", "🎮", "🚀",
  "⚡", "🔥", "🌟", "💎", "🏆", "🎖",
  "🍀", "🍕",
];

function _uuidv4() {
  // RFC4122-ish v4 — good enough for a local client_id.
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  // Fallback
  let s = "";
  const hex = "0123456789abcdef";
  for (let i = 0; i < 32; i++) {
    let r = (Math.random() * 16) | 0;
    if (i === 12) r = 4;
    if (i === 16) r = (r & 0x3) | 0x8;
    s += hex[r];
    if (i === 7 || i === 11 || i === 15 || i === 19) s += "-";
  }
  return s;
}

function _loadLocalUser() {
  try {
    const raw = localStorage.getItem("cs.user");
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (!u || typeof u.client_id !== "string" || u.client_id.length < 4) return null;
    return u;
  } catch { return null; }
}

function _saveLocalUser() {
  try {
    localStorage.setItem("cs.user", JSON.stringify({
      client_id: state.user.client_id,
      nickname: state.user.nickname,
      avatar: state.user.avatar,
    }));
  } catch (_) { /* ignore */ }
}

async function syncUserProfile() {
  if (!state.user.client_id) return null;
  try {
    const u = await api("/api/users/upsert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: state.user.client_id,
        nickname: state.user.nickname || "Гость",
        avatar: state.user.avatar || "♟",
      }),
    });
    // Server is authoritative for rating + stats. Pulling them down on
    // every sync keeps the local view honest if e.g. users.json was
    // reset or the user's localStorage drifted out of sync.
    if (u && typeof u === "object") {
      if (typeof u.rating === "number") {
        state.puzzle.sessionRating = u.rating;
        state.user.rating = u.rating;
      }
      if (u.stats && typeof u.stats === "object") {
        if (typeof u.stats.current_streak === "number") {
          state.puzzle.sessionStats.streak = u.stats.current_streak;
        }
        if (typeof u.stats.best_streak === "number") {
          state.puzzle.sessionStats.bestStreak = Math.max(
            state.puzzle.sessionStats.bestStreak,
            u.stats.best_streak,
          );
        }
      }
      _savePuzzleSession();
    }
    return u;
  } catch { return null; }
}

async function userHeartbeat() {
  if (!state.user.client_id) return;
  try {
    await api("/api/users/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: state.user.client_id }),
    });
  } catch { /* ignore */ }
}

async function recordPuzzleAttemptOnServer(payload) {
  if (!state.user.client_id) return null;
  try {
    return await api("/api/users/puzzle_attempt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: state.user.client_id, ...payload }),
    });
  } catch { return null; }
}

function _renderOnboardingAvatars(selected) {
  const host = document.getElementById("onboarding-avatars");
  if (!host) return;
  host.innerHTML = AVATAR_CHOICES.map((a) => {
    const cls = a === selected ? "onboarding-avatar is-selected" : "onboarding-avatar";
    return `<button type="button" class="${cls}" data-avatar="${escapeHtml(a)}">${escapeHtml(a)}</button>`;
  }).join("");
  host.querySelectorAll(".onboarding-avatar").forEach((btn) => {
    btn.addEventListener("click", () => {
      host.querySelectorAll(".onboarding-avatar").forEach((b) => b.classList.remove("is-selected"));
      btn.classList.add("is-selected");
      // Picking a glyph drops any previously-staged photo.
      _onboardingPhoto = null;
      _renderOnboardingPhotoPreview(btn.dataset.avatar || "♟");
    });
  });
}

// Photo state for the onboarding modal. While the modal is open, we
// stage the user's choice locally:
//   • `_onboardingPhoto = { url, file? }` — a custom photo (already
//     uploaded to /api/avatars/<cid>.png if `url` is set, or pending
//     upload if `file` is set and `url` is null).
//   • `_onboardingPhoto = null` — fall back to the selected glyph.
let _onboardingPhoto = null;

function _renderOnboardingPhotoPreview(glyph) {
  const host = document.getElementById("onboarding-photo-preview");
  const clearBtn = document.getElementById("btn-onboarding-photo-clear");
  if (!host) return;
  if (_onboardingPhoto && _onboardingPhoto.url) {
    host.innerHTML = `<img src="${escapeHtml(_onboardingPhoto.url)}" alt="" referrerpolicy="no-referrer">`;
    if (clearBtn) clearBtn.hidden = false;
    return;
  }
  host.textContent = glyph || "♟";
  if (clearBtn) clearBtn.hidden = true;
}

async function _uploadAvatarFile(file) {
  if (!file) return null;
  if (!state.user.client_id) state.user.client_id = _uuidv4();
  const status = document.getElementById("onboarding-photo-status");
  if (status) status.textContent = "Загружаю…";
  try {
    const fd = new FormData();
    fd.append("file", file, file.name || "avatar");
    const res = await fetch(`/api/users/avatar?client_id=${encodeURIComponent(state.user.client_id)}`, {
      method: "POST",
      body: fd,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(detail || `HTTP ${res.status}`);
    }
    const data = await res.json();
    if (status) status.textContent = "Готово";
    return data && data.avatar ? data.avatar : null;
  } catch (e) {
    if (status) status.textContent = "Ошибка загрузки";
    return null;
  }
}

function showOnboarding() {
  const modal = document.getElementById("onboarding-modal");
  if (!modal) return;
  const nickInput = document.getElementById("onboarding-nick");
  if (nickInput) nickInput.value = state.user.nickname || "";
  // Seed the photo preview from the persisted user state so re-opening
  // the editor shows the existing custom photo instead of resetting.
  const cur = state.user.avatar || "♟";
  if (_isAvatarImageUrl(cur)) {
    _onboardingPhoto = { url: cur };
    _renderOnboardingAvatars("♟");
  } else {
    _onboardingPhoto = null;
    _renderOnboardingAvatars(cur);
  }
  _renderOnboardingPhotoPreview(_isAvatarImageUrl(cur) ? "" : cur);
  const status = document.getElementById("onboarding-photo-status");
  if (status) status.textContent = "";
  modal.hidden = false;
  setTimeout(() => nickInput && nickInput.focus(), 50);
}

function hideOnboarding() {
  const modal = document.getElementById("onboarding-modal");
  if (modal) modal.hidden = true;
}

function _selectedOnboardingAvatar() {
  const sel = document.querySelector("#onboarding-avatars .onboarding-avatar.is-selected");
  return (sel && sel.dataset.avatar) || "♟";
}

document.getElementById("btn-onboarding-photo")?.addEventListener("click", () => {
  document.getElementById("onboarding-photo-input")?.click();
});

document.getElementById("onboarding-photo-input")?.addEventListener("change", async (e) => {
  const input = e.currentTarget;
  const file = input.files && input.files[0];
  if (!file) return;
  const url = await _uploadAvatarFile(file);
  if (url) {
    _onboardingPhoto = { url };
    _renderOnboardingPhotoPreview("");
  }
  // Reset the input so picking the same file twice in a row still fires.
  input.value = "";
});

document.getElementById("btn-onboarding-photo-clear")?.addEventListener("click", async () => {
  if (!state.user.client_id) {
    _onboardingPhoto = null;
    _renderOnboardingPhotoPreview(_selectedOnboardingAvatar() || "♟");
    return;
  }
  try {
    await fetch(`/api/users/avatar?client_id=${encodeURIComponent(state.user.client_id)}`, { method: "DELETE" });
  } catch (_) { /* best-effort */ }
  _onboardingPhoto = null;
  _renderOnboardingPhotoPreview(_selectedOnboardingAvatar() || "♟");
});

document.getElementById("btn-onboarding-save")?.addEventListener("click", async () => {
  const nickInput = document.getElementById("onboarding-nick");
  const nickname = (nickInput?.value || "").trim().slice(0, 32) || "Гость";
  // The photo path takes precedence over a glyph if the user uploaded
  // one, otherwise we fall back to the selected emoji.
  const avatar = (_onboardingPhoto && _onboardingPhoto.url)
    ? _onboardingPhoto.url
    : _selectedOnboardingAvatar();
  if (!state.user.client_id) state.user.client_id = _uuidv4();
  state.user.nickname = nickname;
  state.user.avatar = avatar;
  _saveLocalUser();
  await syncUserProfile();
  hideOnboarding();
});

// Hamburger menu (Profile / Leaderboard).
const userMenuBtn = document.getElementById("btn-user-menu");
const userMenuDropdown = document.getElementById("user-menu-dropdown");
function toggleUserMenu(force) {
  if (!userMenuDropdown || !userMenuBtn) return;
  const next = typeof force === "boolean" ? force : userMenuDropdown.hidden;
  userMenuDropdown.hidden = !next;
  userMenuBtn.setAttribute("aria-expanded", next ? "true" : "false");
}
userMenuBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleUserMenu();
});
document.addEventListener("click", (e) => {
  if (!userMenuDropdown || userMenuDropdown.hidden) return;
  if (e.target instanceof Node && (userMenuBtn?.contains(e.target) || userMenuDropdown.contains(e.target))) return;
  toggleUserMenu(false);
});
userMenuDropdown?.querySelectorAll(".user-menu-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    toggleUserMenu(false);
    const action = btn.dataset.action;
    if (action === "profile") {
      openProfileModal(state.user.client_id);
    } else if (action === "leaderboard") {
      openLeaderboardModal();
    }
  });
});

// Modal close handlers.
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const id = btn.dataset.close;
    const modal = id && document.getElementById(id);
    if (modal) modal.hidden = true;
  });
});
document.querySelectorAll(".modal-overlay").forEach((overlay) => {
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
});

function _formatLastSeen(ts) {
  if (!ts) return "—";
  const sec = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (sec < 60)        return "только что";
  if (sec < 60 * 60)   return `${Math.floor(sec / 60)} мин назад`;
  if (sec < 86400)     return `${Math.floor(sec / 3600)} ч назад`;
  if (sec < 7 * 86400) return `${Math.floor(sec / 86400)} дн назад`;
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function _eloHistoryFiltered(history, period) {
  if (!Array.isArray(history) || history.length === 0) return [];
  const nowSec = Math.floor(Date.now() / 1000);
  let cutoff = 0;
  if (period === "7d")  cutoff = nowSec - 7 * 86400;
  if (period === "90d") cutoff = nowSec - 90 * 86400;
  return history.filter((h) => (typeof h.ts === "number" ? h.ts >= cutoff : true));
}

function renderEloGraph(host, history) {
  if (!host) return;
  if (!history || history.length < 2) {
    host.innerHTML = `<div class="elo-graph-empty">Недостаточно данных. Реши пару пазлов, чтобы увидеть график.</div>`;
    return;
  }
  const points = history.map((h) => ({
    ts: typeof h.ts === "number" ? h.ts : 0,
    rating: typeof h.rating === "number" ? h.rating : 1200,
  }));
  const ratings = points.map((p) => p.rating);
  const tmin = points[0].ts;
  const tmax = points[points.length - 1].ts;
  const tspan = Math.max(1, tmax - tmin);
  const rmin = Math.min(...ratings);
  const rmax = Math.max(...ratings);
  const rpad = Math.max(20, (rmax - rmin) * 0.15);
  const ylo = Math.max(0, Math.floor(rmin - rpad));
  const yhi = Math.ceil(rmax + rpad);
  const w = 600, h = 160, padL = 32, padR = 8, padT = 10, padB = 22;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const xOf = (ts) => padL + ((ts - tmin) / tspan) * innerW;
  const yOf = (r)  => padT + (1 - (r - ylo) / Math.max(1, yhi - ylo)) * innerH;
  let path = "";
  points.forEach((p, i) => {
    const x = xOf(p.ts), y = yOf(p.rating);
    path += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
  });
  const fillPath = path + `L ${xOf(tmax).toFixed(1)} ${(padT + innerH).toFixed(1)} L ${xOf(tmin).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`;
  const yticks = 4;
  const tickLines = [];
  for (let i = 0; i <= yticks; i++) {
    const r = Math.round(ylo + ((yhi - ylo) * i) / yticks);
    const y = yOf(r);
    tickLines.push(
      `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${(w - padR).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#1f2a3a" stroke-width="1" />`,
      `<text x="${padL - 6}" y="${(y + 4).toFixed(1)}" fill="#94a4be" font-size="10" text-anchor="end">${r}</text>`
    );
  }
  host.innerHTML = `
    <div class="elo-graph-wrap">
      <svg class="elo-graph" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
        ${tickLines.join("")}
        <path d="${fillPath}" fill="url(#elo-grad)" opacity="0.3" />
        <path d="${path}" fill="none" stroke="#6da7ff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        <g class="elo-cursor" visibility="hidden">
          <line class="elo-cursor-line" y1="${padT}" y2="${padT + innerH}" stroke="#6da7ff" stroke-width="1" stroke-dasharray="3 3" opacity="0.8" />
          <circle class="elo-cursor-dot" r="4.5" fill="#6da7ff" stroke="#fff" stroke-width="1.5" />
        </g>
        <rect class="elo-graph-hover" x="${padL}" y="${padT}" width="${innerW}" height="${innerH}" fill="transparent" />
        <defs>
          <linearGradient id="elo-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stop-color="#6da7ff" stop-opacity="0.6" />
            <stop offset="100%" stop-color="#6da7ff" stop-opacity="0" />
          </linearGradient>
        </defs>
      </svg>
      <div class="elo-graph-tip" hidden>
        <div class="elo-graph-tip-rating"></div>
        <div class="elo-graph-tip-date"></div>
        <div class="elo-graph-tip-delta"></div>
      </div>
    </div>
  `;
  _wireEloGraphHover(host, {
    points, w, h, padL, padR, padT, padB, innerW, xOf, yOf,
  });
}

// Mouse-tracking crosshair + tooltip for the Elo chart. The SVG uses
// preserveAspectRatio="none" so its viewBox stretches to the host;
// we convert clientX -> SVG-x via getBoundingClientRect, then snap
// to the closest data point by timestamp.
function _wireEloGraphHover(host, ctx) {
  const wrap = host.querySelector(".elo-graph-wrap");
  const svg = host.querySelector(".elo-graph");
  const hot = host.querySelector(".elo-graph-hover");
  const cur = host.querySelector(".elo-cursor");
  const line = host.querySelector(".elo-cursor-line");
  const dot = host.querySelector(".elo-cursor-dot");
  const tip = host.querySelector(".elo-graph-tip");
  const ratingEl = host.querySelector(".elo-graph-tip-rating");
  const dateEl = host.querySelector(".elo-graph-tip-date");
  const deltaEl = host.querySelector(".elo-graph-tip-delta");
  if (!wrap || !svg || !hot || !cur || !tip) return;
  const pts = ctx.points;
  const onMove = (ev) => {
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0) return;
    const px = ev.clientX - rect.left;
    // Map screen-x to SVG viewBox-x.
    const svgX = (px / rect.width) * ctx.w;
    // Clamp to plot area.
    const clampedX = Math.max(ctx.padL, Math.min(ctx.w - ctx.padR, svgX));
    // Pick nearest point by SVG-x distance — points are
    // monotonically increasing in ts so x is monotonic too.
    let best = 0, bestDx = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = Math.abs(ctx.xOf(pts[i].ts) - clampedX);
      if (dx < bestDx) { bestDx = dx; best = i; }
    }
    const p = pts[best];
    const x = ctx.xOf(p.ts), y = ctx.yOf(p.rating);
    line.setAttribute("x1", x.toFixed(1));
    line.setAttribute("x2", x.toFixed(1));
    dot.setAttribute("cx", x.toFixed(1));
    dot.setAttribute("cy", y.toFixed(1));
    cur.setAttribute("visibility", "visible");
    // Compose tooltip.
    ratingEl.textContent = `Эло ${p.rating}`;
    const dt = new Date(p.ts * 1000);
    const datePart = dt.toLocaleDateString("ru-RU", {
      day: "numeric", month: "short", year: "numeric",
    });
    const timePart = dt.toLocaleTimeString("ru-RU", {
      hour: "2-digit", minute: "2-digit",
    });
    dateEl.textContent = `${datePart} · ${timePart}`;
    if (best > 0) {
      const dr = p.rating - pts[best - 1].rating;
      deltaEl.textContent = dr === 0 ? "Δ 0" : (dr > 0 ? `▲ +${dr}` : `▼ ${dr}`);
      deltaEl.className = "elo-graph-tip-delta " + (dr > 0 ? "is-up" : (dr < 0 ? "is-down" : "is-flat"));
      deltaEl.hidden = false;
    } else {
      deltaEl.hidden = true;
    }
    // Position tooltip in client coords. Center horizontally above
    // the dot, clamp to host bounds.
    tip.hidden = false;
    const wrapRect = wrap.getBoundingClientRect();
    const dotClientX = rect.left + (x / ctx.w) * rect.width;
    const dotClientY = rect.top + (y / ctx.h) * rect.height;
    const tipW = tip.offsetWidth || 120;
    const tipH = tip.offsetHeight || 50;
    let tipX = dotClientX - wrapRect.left - tipW / 2;
    let tipY = dotClientY - wrapRect.top - tipH - 14;
    if (tipX < 4) tipX = 4;
    if (tipX + tipW > wrapRect.width - 4) tipX = wrapRect.width - tipW - 4;
    if (tipY < 4) {
      // Not enough room above — flip below the point.
      tipY = dotClientY - wrapRect.top + 14;
    }
    tip.style.left = `${tipX}px`;
    tip.style.top = `${tipY}px`;
  };
  const onLeave = () => {
    cur.setAttribute("visibility", "hidden");
    tip.hidden = true;
  };
  hot.addEventListener("mousemove", onMove);
  hot.addEventListener("mouseleave", onLeave);
  // Touch support: tap and drag along the chart.
  hot.addEventListener("touchmove", (ev) => {
    const t = ev.touches[0];
    if (t) onMove({ clientX: t.clientX, clientY: t.clientY });
  });
  hot.addEventListener("touchend", onLeave);
}

async function openProfileModal(clientId) {
  const modal = document.getElementById("profile-modal");
  const body = document.getElementById("profile-body");
  if (!modal || !body) return;
  body.innerHTML = `<div class="profile-empty">Загружаю профиль…</div>`;
  modal.hidden = false;
  let user = null;
  if (clientId) {
    try {
      user = await api(`/api/users/${encodeURIComponent(clientId)}`);
    } catch { user = null; }
  }
  if (!user) {
    body.innerHTML = `<div class="profile-empty">Профиль не найден на этом сервере.</div>`;
    return;
  }
  if (clientId === state.user.client_id) {
    state.user.elo_history = Array.isArray(user.elo_history) ? user.elo_history : null;
    if (typeof user.rating === "number") state.user.rating = user.rating;
  } else {
    state.user.elo_history = null;
  }
  const stats = user.stats || {};
  const games = stats.games || 0;
  const solved = stats.solved || 0;
  const wrong = stats.wrong || 0;
  const skipped = stats.skipped || 0;
  const winPct = games ? (solved / games * 100).toFixed(1) : "0";
  const isSelf = user.client_id === state.user.client_id;
  body.innerHTML = `
    <header class="profile-header">
      <div class="profile-avatar">${avatarHtml(user.avatar, { extraClass: "profile-avatar-img" })}</div>
      <div class="profile-name">
        <h3>${escapeHtml(user.nickname || "Гость")}${isSelf ? " <span class=\"muted\" style=\"font-size:13px; font-weight:500;\">(вы)</span>" : ""}</h3>
        <div class="muted">Последний раз: ${_formatLastSeen(user.last_seen)}</div>
      </div>
      ${isSelf ? `<button id="btn-profile-edit" type="button" class="puzzle-secondary" style="margin-left:auto;">Изменить</button>` : ""}
    </header>
    <section class="profile-stats-grid">
      <div class="profile-stat"><span class="ps-label">Рейтинг</span><span class="ps-val rating">${user.rating || 1200}</span></div>
      <div class="profile-stat"><span class="ps-label">Игр</span><span class="ps-val">${games}</span></div>
      <div class="profile-stat"><span class="ps-label">Винрейт</span><span class="ps-val">${winPct}%</span></div>
      <div class="profile-stat"><span class="ps-label">Решено</span><span class="ps-val ok">${solved}</span></div>
      <div class="profile-stat"><span class="ps-label">Ошибок</span><span class="ps-val bad">${wrong}</span></div>
      <div class="profile-stat"><span class="ps-label">Пропуск</span><span class="ps-val">${skipped}</span></div>
      <div class="profile-stat"><span class="ps-label">Серия</span><span class="ps-val warn">🔥 ${stats.current_streak || 0}</span></div>
      <div class="profile-stat"><span class="ps-label">Макс серия</span><span class="ps-val warn">${stats.best_streak || 0}</span></div>
    </section>
    <section class="profile-section">
      <h4>График Эло</h4>
      <div class="elo-period-tabs" id="elo-period-tabs">
        <button type="button" class="elo-period-tab is-active" data-period="all">Всё время</button>
        <button type="button" class="elo-period-tab" data-period="90d">90 дней</button>
        <button type="button" class="elo-period-tab" data-period="7d">7 дней</button>
      </div>
      <div id="elo-graph-host"></div>
    </section>
    ${Array.isArray(user.parties) && user.parties.length ? `
    <section class="profile-section">
      <h4>История пати-матчей</h4>
      <div class="profile-parties-list" id="profile-parties-list">${user.parties.slice(-20).reverse().map((p, idx) => {
        const date = p.ts ? new Date(Number(p.ts) * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
        const dur = _formatPartyDuration(p.duration_sec || 0);
        const winrate = Number(p.winrate || 0);
        const place = Number(p.placement || 0);
        const placeCls = place === 1 ? "ok" : (place === 2 ? "warn" : "");
        // Mode badge: "Стандартный" → ср.ELO, "Кастомный" → диапазон.
        // Older entries written before the mode field landed are
        // treated as standard so their badge still says "Стандартный"
        // (with the avg if it was logged).
        const mode = (p.mode === "custom") ? "custom" : "standard";
        const rmin = Number(p.rating_min || 0);
        const rmax = Number(p.rating_max || 0);
        const avg = Number(p.avg_rating || 0);
        const modeText = mode === "custom"
          ? (rmin > 0 && rmax > 0 ? `Кастом · ELO ${rmin}–${rmax}` : "Кастом")
          : (avg > 0 ? `Стандарт · ср.ELO ${avg}` : "Стандарт");
        const modeCls = mode === "custom" ? "is-custom" : "is-standard";
        return `
          <button type="button" class="profile-party-row" data-idx="${idx}" title="Открыть подробный результат">
            <span class="pp-rank ${placeCls}">#${place}</span>
            <span class="pp-meta">
              <span class="pp-date">${escapeHtml(date)}</span>
              <span class="pp-duration muted">${escapeHtml(dur || "—")}</span>
              <span class="pp-mode ${modeCls}">${escapeHtml(modeText)}</span>
            </span>
            <span class="pp-stats">
              <span class="ok">✔ ${Number(p.solved || 0)}</span>
              <span class="bad">✘ ${Number(p.failed || 0)}</span>
              <span class="warn">↷ ${Number(p.skipped || 0)}</span>
              <span>${winrate.toFixed(1)}%</span>
            </span>
            <span class="pp-score">${Number(p.score || 0)} pts</span>
            <span class="pp-chevron muted">›</span>
          </button>`;
      }).join("")}</div>
    </section>` : ""}
  `;
  const eloHost = document.getElementById("elo-graph-host");
  renderEloGraph(eloHost, user.elo_history || []);
  document.getElementById("elo-period-tabs")?.querySelectorAll(".elo-period-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#elo-period-tabs .elo-period-tab").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      const filtered = _eloHistoryFiltered(user.elo_history || [], btn.dataset.period);
      renderEloGraph(eloHost, filtered);
    });
  });
  document.getElementById("btn-profile-edit")?.addEventListener("click", () => {
    modal.hidden = true;
    showOnboarding();
  });
  // Wire each party history row to its persisted detail modal. We
  // index against the original `parties` array (newest-first display)
  // so the click target reliably maps back to the saved record.
  // History is open for any user — leaderboard click on a friend
  // also lets you browse their detailed match logs.
  const partiesAsc = Array.isArray(user.parties) ? user.parties : [];
  const partiesDesc = partiesAsc.slice(-20).reverse();
  document.querySelectorAll("#profile-parties-list .profile-party-row").forEach((row) => {
    row.addEventListener("click", () => {
      const idx = Number(row.dataset.idx);
      const entry = partiesDesc[idx];
      if (!entry) return;
      // Hide profile modal so the party detail modal pops on top
      // cleanly; user can re-open profile via the avatar button.
      modal.hidden = true;
      openPartyResultDetail(entry, { ownerId: user.client_id, ownerNickname: user.nickname, ownerAvatar: user.avatar });
    });
  });
}

async function openLeaderboardModal() {
  const modal = document.getElementById("leaderboard-modal");
  const body = document.getElementById("leaderboard-body");
  if (!modal || !body) return;
  body.innerHTML = `<div class="profile-empty">Загружаю лидерборд…</div>`;
  modal.hidden = false;
  let users = [];
  try {
    const r = await api("/api/users");
    users = (r && r.users) || [];
  } catch { users = []; }
  if (!users.length) {
    body.innerHTML = `<div class="profile-empty">Пока никого нет. Реши первый пазл, чтобы появиться здесь.</div>`;
    return;
  }
  const rowsHtml = users.map((u, idx) => {
    const isSelf = u.client_id === state.user.client_id;
    return `
      <tr class="leaderboard-row ${isSelf ? "is-self" : ""}" data-cid="${escapeHtml(u.client_id)}">
        <td class="lb-rank">#${idx + 1}</td>
        <td>
          <span class="lb-avatar">${avatarHtml(u.avatar)}</span>
          <span class="lb-name">${escapeHtml(u.nickname || "Гость")}${isSelf ? " <span class=\"muted\">(вы)</span>" : ""}</span>
        </td>
        <td class="lb-rating">${u.rating}</td>
        <td>${u.games}</td>
        <td class="lb-pct">${u.win_pct}%</td>
        <td class="lb-pct">${u.best_streak}</td>
        <td class="muted">${_formatLastSeen(u.last_seen)}</td>
      </tr>
    `;
  }).join("");
  body.innerHTML = `
    <table class="leaderboard-table">
      <thead>
        <tr>
          <th>#</th><th>Игрок</th><th>Эло</th><th>Игр</th><th>Винрейт</th><th>Макс серия</th><th>В сети</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  `;
  body.querySelectorAll(".leaderboard-row").forEach((row) => {
    row.addEventListener("click", () => {
      modal.hidden = true;
      openProfileModal(row.dataset.cid);
    });
  });
}

async function _bootUser() {
  const stored = _loadLocalUser();
  if (stored) {
    state.user.client_id = stored.client_id;
    state.user.nickname = stored.nickname || "Гость";
    state.user.avatar = stored.avatar || "♟";
    await syncUserProfile();
  } else {
    state.user.client_id = _uuidv4();
    showOnboarding();
  }
  // Heartbeat every 60s so last-seen stays fresh on the leaderboard.
  setInterval(userHeartbeat, 60_000);
  // Start the SSE notifications stream so party invitations pop up live.
  _bootNotifications();
  // If the user reloads while a puzzle was already in progress, the
  // session-restore path in enterPuzzleView re-flips the board and
  // calls renderBoard but does NOT call loadNextPuzzle (which is
  // where presenceConnect now lives), so we'd never appear in the
  // Оффлайн list. Catch that here: if we're on the puzzle tab and
  // a puzzle is actually loaded (not the idle start screen),
  // register presence now that client_id is known.
  if (state.view === "puzzle"
      && state.puzzle.current && !state.puzzle.idle) {
    try { presenceConnect(); } catch (_) { /* ignore */ }
  }
}

// ---------- Party (co-op puzzles over WebSocket) ----------

function _partyWsUrl(code) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const u = new URL(`${proto}//${location.host}/api/party/ws/${encodeURIComponent(code)}`);
  u.searchParams.set("client_id", state.user.client_id || "");
  u.searchParams.set("nickname", state.user.nickname || "");
  u.searchParams.set("avatar", state.user.avatar || "");
  // Send the player's local UI prefs so spectators can render this
  // player's mini-board in *their* theme + pieces, not the watcher's.
  u.searchParams.set("theme", userSettings.theme || "");
  u.searchParams.set("pieces", userSettings.pieces || "");
  // Legal-move hint colour the player picked — spectators paint their
  // dots/rings in this same colour.
  if (_isHexColor(userSettings.legalDotColor)) {
    u.searchParams.set("legal_color", userSettings.legalDotColor);
  }
  return u.toString();
}

function _partyEnsureModal(opts) {
  // Battle (formerly Party) used to live in a modal launched from the
  // burger menu. We've since promoted it to a full top-bar tab
  // (`#tab-battle`) — the lobby / scoreboard / results render directly
  // inside the side-panel container `#battle-body`. We keep the legacy
  // modal node in the DOM as a fallback host in case future code paths
  // open it before the panel has a chance to mount, but the panel is
  // always the preferred render target. Callers are responsible for
  // switching the view to "battle" (so the panel is visible) — we
  // deliberately don't do it here to keep this helper free of
  // recursive setView calls.
  //
  // Exception: callers that open from outside the Battle tab (e.g.
  // a "history" row in the profile modal) pass `useModal: true` so
  // we render into the legacy `#party-modal` overlay instead — the
  // side-panel is hidden behind another view there and writing to it
  // would produce a visibly empty modal frame.
  const useModal = !!(opts && opts.useModal);
  if (!useModal) {
    const panelBody = document.getElementById("battle-body");
    if (panelBody) {
      panelBody.classList.toggle("party-card-results", !!(opts && opts.results));
      return panelBody;
    }
  }
  const m = document.getElementById("party-modal");
  if (m) m.hidden = false;
  const card = m && m.querySelector(".modal-card");
  if (card) {
    card.classList.toggle("party-card-results", !!(opts && opts.results));
  }
  return document.getElementById("party-body");
}

// ---------- Presence (solo broadcast for the "Оффлайн" tab) ----------
//
// While the user is solving puzzles outside a party we keep an open
// WebSocket so the server can fan-out their cursor / FEN / selection
// to anyone watching. The connection is opened on enterPuzzleView()
// and torn down on leavePuzzleView() or when joining a party (party
// takes precedence — same socket would race both broadcasts).

function _presenceWsUrl() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const u = new URL(`${proto}//${location.host}/api/presence/ws`);
  u.searchParams.set("client_id", state.user.client_id || "");
  u.searchParams.set("nickname", state.user.nickname || "");
  u.searchParams.set("avatar", state.user.avatar || "");
  u.searchParams.set("role", "player");
  u.searchParams.set("theme", userSettings.theme || "");
  u.searchParams.set("pieces", userSettings.pieces || "");
  if (_isHexColor(userSettings.legalDotColor)) {
    u.searchParams.set("legal_color", userSettings.legalDotColor);
  }
  const r = (state.user && Number(state.user.rating))
    || (state.puzzle && Number(state.puzzle.sessionRating))
    || 0;
  if (r) u.searchParams.set("rating", String(r));
  return u.toString();
}

function presenceConnect() {
  if (!state.user.client_id) return;
  if (state.party.active) return; // party owns the live channel
  if (state.presence.ws) {
    try {
      if (state.presence.ws.readyState === WebSocket.OPEN
          || state.presence.ws.readyState === WebSocket.CONNECTING) {
        return;
      }
    } catch (_) { /* ignore */ }
  }
  let ws;
  try { ws = new WebSocket(_presenceWsUrl()); }
  catch (_) { return; }
  state.presence.ws = ws;
  state.presence.active = true;
  ws.onopen = () => {
    // Push current position immediately so spectators who attach
    // right at this moment don't see an empty board.
    try {
      const c = (state.freeplay && state.freeplay.chess)
        || (state.game && state.game.chess) || null;
      const fen = c ? c.fen() : "";
      if (fen) _partyReportPosition(fen);
      _partySyncSelectionFromState();
    } catch (_) { /* ignore */ }
  };
  ws.onmessage = () => { /* server-only signals; ignore */ };
  ws.onerror = () => { /* surface as close */ };
  ws.onclose = () => {
    if (state.presence.ws === ws) {
      state.presence.ws = null;
      state.presence.active = false;
    }
  };
}

function presenceDisconnect() {
  const ws = state.presence.ws;
  state.presence.ws = null;
  state.presence.active = false;
  if (ws) {
    try { ws.close(); } catch (_) { /* ignore */ }
  }
}

function _formatPartyTimeLeft(endsAt) {
  const ms = Math.max(0, endsAt * 1000 - Date.now());
  const sec = Math.floor(ms / 1000);
  const mm = Math.floor(sec / 60);
  const ss = sec % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function openPartyModal() {
  if (!state.user.client_id) return;
  // Promote to the Battle tab if we're not already there. enterBattleView()
  // will re-render this lobby UI on its own — but we still call into the
  // chooser renderer below so callers that arrive here directly (e.g. from
  // accepting an invite) get fresh content immediately.
  if (state.view !== "battle") setView("battle");
  const body = _partyEnsureModal();
  if (!body) return;
  if (state.party.active && state.party.status === "playing") {
    // Battle is in flight — render the live scoreboard inside the panel
    // instead of the chooser, so peeking at Battle while playing is
    // useful (was a no-op before).
    _partyMountSidePanel();
    _partyRenderScoreboard();
    return;
  }
  if (state.party.active && state.party.status === "lobby") {
    // Already connected to a lobby — render that lobby instead of the
    // chooser (otherwise we'd lose the joined party).
    renderPartyLobby();
    return;
  }
  body.innerHTML = `
    <header class="party-header">
      <h2><span class="battle-h-icon" aria-hidden="true">${BATTLE_SWORDS_SVG}</span>Puzzle Battle</h2>
      <p class="muted">Каждому участнику даётся 10 минут на свой поток пазлов; в конце — общий лидерборд.</p>
    </header>

    <div class="party-tabs" role="tablist">
      <button type="button" class="party-tab is-active" data-tab="online" role="tab" aria-selected="true">Онлайн</button>
      <button type="button" class="party-tab" data-tab="offline" role="tab" aria-selected="false">Оффлайн</button>
    </div>

    <section class="party-tab-panel" data-panel="online">
      <div class="party-section-title">
        Открытые пати
        <button id="btn-party-open-refresh" type="button" class="puzzle-ghost party-refresh-btn" title="Обновить">⟳</button>
      </div>
      <div id="party-open-list" class="party-open-list">
        <div class="party-open-empty">Загружаю…</div>
      </div>

      <div class="party-actions" style="margin-top: 14px;">
        <button id="btn-party-create" type="button" class="puzzle-primary">Создать комнату и пригласить</button>
      </div>

      <details class="party-fallback" style="margin-top: 14px;">
        <summary class="muted" style="cursor: pointer;">Войти по коду (старый способ)</summary>
        <div class="party-actions" style="margin-top: 8px;">
          <input id="party-join-code" type="text" maxlength="8" placeholder="КОД" class="party-code-input" />
          <button id="btn-party-join" type="button" class="puzzle-secondary">Войти</button>
        </div>
      </details>
    </section>

    <section class="party-tab-panel" data-panel="offline" hidden>
      <div class="party-section-title">
        Игроки соло-пазлов
        <button id="btn-presence-refresh" type="button" class="puzzle-ghost party-refresh-btn" title="Обновить">⟳</button>
      </div>
      <p class="muted" style="font-size: 12px; margin: 4px 0 8px;">
        Игроки решают пазлы на настоящие эло. Кликни по карточке, чтобы наблюдать за их доской в реальном времени.
      </p>
      <div id="presence-open-list" class="party-open-list">
        <div class="party-open-empty">Загружаю…</div>
      </div>
    </section>

    <div id="party-error" class="party-error" hidden></div>
  `;
  body.querySelector("#btn-party-create").addEventListener("click", () => {
    partyCreateAndInvite().catch((e) => _partyShowError(e));
  });
  body.querySelector("#btn-party-open-refresh")?.addEventListener("click", () => {
    _renderOpenPartiesList().catch(() => {});
  });
  body.querySelector("#btn-party-join").addEventListener("click", () => {
    const code = (body.querySelector("#party-join-code").value || "").trim().toUpperCase();
    if (!code) return;
    partyJoin(code).catch((e) => _partyShowError(e));
  });
  body.querySelector("#party-join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") body.querySelector("#btn-party-join").click();
  });
  // Tab switcher.
  body.querySelectorAll(".party-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      body.querySelectorAll(".party-tab").forEach((b) => {
        const active = b.dataset.tab === tab;
        b.classList.toggle("is-active", active);
        b.setAttribute("aria-selected", active ? "true" : "false");
      });
      body.querySelectorAll(".party-tab-panel").forEach((p) => {
        p.hidden = p.dataset.panel !== tab;
      });
      if (tab === "offline") _renderPresenceList().catch(() => {});
    });
  });
  body.querySelector("#btn-presence-refresh")?.addEventListener("click", () => {
    _renderPresenceList().catch(() => {});
  });
  // Async fills.
  _renderOpenPartiesList().catch(() => {});
}

function _partyShowError(e) {
  const errEl = document.getElementById("party-error");
  if (!errEl) return;
  errEl.hidden = false;
  errEl.textContent = e && e.message ? e.message : "Ошибка";
}

function closePartyModal() {
  // Hide the legacy modal if it's still around. The Battle tab itself
  // is dismissed by switching the view back to puzzle (or whatever the
  // user picks); we do that in the start / spectate flows directly.
  const m = document.getElementById("party-modal");
  if (m) m.hidden = true;
  const panel = document.getElementById("battle-body");
  if (panel) panel.classList.remove("party-card-results");
}

async function partyCreate() {
  const res = await fetch("/api/party/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: state.user.client_id,
      nickname: state.user.nickname,
      avatar: state.user.avatar,
    }),
  });
  if (!res.ok) throw new Error(`Не удалось создать (HTTP ${res.status})`);
  const data = await res.json();
  partyConnect(data.code);
}

async function partyJoin(code) {
  const res = await fetch(`/api/party/${encodeURIComponent(code)}`);
  if (res.status === 404) throw new Error("Комната не найдена");
  if (!res.ok) throw new Error(`Ошибка: HTTP ${res.status}`);
  partyConnect(code);
}

function partyConnect(code) {
  if (state.party.ws) {
    try { state.party.ws.close(); } catch (_) {}
  }
  // Party owns the live broadcast channel — drop the solo presence
  // socket so spectator messages don't get duplicated across both.
  try { presenceDisconnect(); } catch (_) { /* ignore */ }
  state.party.code = code;
  state.party.active = true;
  state.party.status = "lobby";
  state.party.finalResults = null;
  state.party.finalMeta = null;
  state.party.scoreboard = [];
  state.party.members = [];
  // Match length is fixed at 3 min (chess.com Puzzle Battle style);
  // the duration selector is gone but we keep the field around so
  // legacy code paths reading state.party.durationSec still work.
  state.party.durationSec = 180;
  state.party.allowedDurations = [180];
  const ws = new WebSocket(_partyWsUrl(code));
  state.party.ws = ws;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handlePartyMessage(msg);
  };
  ws.onerror = () => _partyShowError(new Error("Соединение потеряно"));
  ws.onclose = () => {
    if (state.party.active && state.party.status !== "finished") {
      // Disconnected before match end — surface as finished and keep board.
      state.party.active = false;
    }
    if (state.party.countdownInterval) {
      clearInterval(state.party.countdownInterval);
      state.party.countdownInterval = null;
    }
  };
}

function handlePartyMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "lobby":
      state.party.party_id = msg.party_id;
      state.party.host_id = msg.host_id;
      state.party.status = msg.status;
      state.party.endsAt = msg.ends_at || 0;
      state.party.startedAt = msg.started_at || 0;
      // Mirror server-supplied lobby duration so non-host clients see
      // the same selection the host picked, and so the host's UI
      // matches the server-side authoritative value after a reconnect.
      if (Number.isFinite(msg.duration_sec) && msg.duration_sec > 0) {
        state.party.durationSec = Math.floor(msg.duration_sec);
      }
      if (Array.isArray(msg.allowed_durations_sec) && msg.allowed_durations_sec.length) {
        state.party.allowedDurations = msg.allowed_durations_sec.map((n) => Math.floor(Number(n) || 0)).filter((n) => n > 0);
      }
      if (Number.isFinite(msg.lives_per_player) && msg.lives_per_player > 0) {
        state.party.livesPerPlayer = Math.floor(msg.lives_per_player);
      }
      if (Number.isFinite(msg.grid_col_height) && msg.grid_col_height > 0) {
        state.party.gridColHeight = Math.floor(msg.grid_col_height);
      }
      state.party.members = Array.isArray(msg.members) ? msg.members : [];
      if (Number.isFinite(msg.avg_rating)) state.party.avgRating = Math.floor(msg.avg_rating);
      if (typeof msg.mode === "string") state.party.mode = msg.mode;
      if (Number.isFinite(msg.rating_min)) state.party.ratingMin = Math.floor(msg.rating_min);
      if (Number.isFinite(msg.rating_max)) state.party.ratingMax = Math.floor(msg.rating_max);
      if (state.party.status === "lobby") renderPartyLobby();
      break;
    case "start":
      state.party.status = "playing";
      state.party.endsAt = msg.ends_at || 0;
      state.party.startedAt = msg.started_at || 0;
      if (Number.isFinite(msg.duration_sec) && msg.duration_sec > 0) {
        state.party.durationSec = Math.floor(msg.duration_sec);
      }
      if (Number.isFinite(msg.avg_rating)) state.party.avgRating = Math.floor(msg.avg_rating);
      if (typeof msg.mode === "string") state.party.mode = msg.mode;
      if (Number.isFinite(msg.rating_min)) state.party.ratingMin = Math.floor(msg.rating_min);
      if (Number.isFinite(msg.rating_max)) state.party.ratingMax = Math.floor(msg.rating_max);
      state.party.selfScore = 0;
      // Brand new match — clear any leftover "I was eliminated" flag
      // from the previous run so the fresh match doesn't open with a
      // dimmed self-row / locked board.
      state.party.selfEliminated = false;
      closePartyModal();
      setView("puzzle");
      _partyMountSidePanel();
      _partyStartCountdown();
      if (msg.your_puzzle) startPuzzle(_partyAdaptPuzzle(msg.your_puzzle));
      break;
    case "match_state":
      state.party.endsAt = msg.ends_at || state.party.endsAt;
      state.party.startedAt = msg.started_at || state.party.startedAt;
      if (Number.isFinite(msg.duration_sec) && msg.duration_sec > 0) {
        state.party.durationSec = Math.floor(msg.duration_sec);
      }
      if (typeof msg.mode === "string") state.party.mode = msg.mode;
      if (Number.isFinite(msg.rating_min)) state.party.ratingMin = Math.floor(msg.rating_min);
      if (Number.isFinite(msg.rating_max)) state.party.ratingMax = Math.floor(msg.rating_max);
      if (Array.isArray(msg.scoreboard)) state.party.scoreboard = msg.scoreboard;
      _partyMountSidePanel();
      _partyStartCountdown();
      if (msg.your_puzzle) startPuzzle(_partyAdaptPuzzle(msg.your_puzzle));
      break;
    case "next_puzzle":
      if (msg.puzzle) startPuzzle(_partyAdaptPuzzle(msg.puzzle));
      break;
    case "scoreboard":
      state.party.endsAt = msg.ends_at || state.party.endsAt;
      if (Array.isArray(msg.scoreboard)) state.party.scoreboard = msg.scoreboard;
      _partyRenderScoreboard();
      break;
    case "eliminated":
      // Server tells us we just lost our last life. Mark ourselves
      // out so the puzzle UI hides hint/skip and the scoreboard row
      // dims; then offer the "watch the rest of the match as
      // spectator" modal that piggybacks on the existing spectator
      // flow.
      _partyHandleEliminated(msg);
      break;
    case "finish":
      state.party.status = "finished";
      state.party.finalResults = Array.isArray(msg.results) ? msg.results : [];
      state.party.finalMeta = {
        duration_sec: Number(msg.duration_sec) || state.party.durationSec || 0,
        started_at: Number(msg.started_at) || state.party.startedAt || 0,
        ended_at: Number(msg.ended_at) || Math.floor(Date.now() / 1000),
        party_id: msg.party_id || state.party.party_id || "",
        mode: typeof msg.mode === "string" ? msg.mode : state.party.mode,
        rating_min: Number(msg.rating_min) || state.party.ratingMin || 0,
        rating_max: Number(msg.rating_max) || state.party.ratingMax || 0,
        avg_rating: Number(msg.avg_rating) || state.party.avgRating || 0,
      };
      state.party.active = false;
      if (state.party.countdownInterval) {
        clearInterval(state.party.countdownInterval);
        state.party.countdownInterval = null;
      }
      // Tear down the elimination modal if it was still open — the
      // post-match scoreboard supersedes it.
      _partyDismissEliminatedModal();
      _partyShowResults();
      try { state.party.ws && state.party.ws.close(); } catch (_) {}
      break;
    case "error":
      _partyShowError(new Error(msg.message || msg.code || "Ошибка"));
      break;
  }
}

function _partyAdaptPuzzle(p) {
  // The party WS payload mirrors /api/puzzle/random — pass through.
  return {
    id: p.id,
    fen: p.fen,
    moves: p.moves || [],
    rating: p.rating || 1200,
    side_to_solve: p.side_to_solve || null,
    themes: p.themes || [],
    themes_ru: p.themes || [],
    url: p.url || null,
  };
}

function sendPartyAttempt(payload) {
  const ws = state.party.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "attempt", ...payload }));
  } catch (_) { /* already closed */ }
}

// Returns whichever live broadcast WebSocket is currently active
// (party first, presence second), or null if neither. Both endpoints
// accept the same {position, select, cursor} message vocabulary so
// the helpers below use a single payload regardless of channel.
function _liveBroadcastWs() {
  if (state.party.active && state.party.status === "playing"
      && state.party.ws && state.party.ws.readyState === WebSocket.OPEN) {
    return state.party.ws;
  }
  if (state.presence && state.presence.active
      && state.presence.ws && state.presence.ws.readyState === WebSocket.OPEN) {
    return state.presence.ws;
  }
  return null;
}

function _liveIsActive() {
  return _liveBroadcastWs() !== null;
}

// Broadcast the player's current FEN to spectators. Routed to the
// active party or solo-presence WebSocket — no-op if neither is live.
// Throttling is handled server-side. We piggy-back the current board
// orientation and the last applied move so watchers can mirror the
// player's view exactly (same flip + same yellow last-move highlight).
function _partyReportPosition(fen, opts) {
  const ws = _liveBroadcastWs();
  if (!ws) return;
  const lm = (opts && opts.lastMove) || state.lastMove;
  const lastMoveStr = (lm && lm.from && lm.to) ? `${lm.from}${lm.to}` : "";
  // Solo-presence consumers also need the puzzle id / rating /
  // streak to render the watcher's overlay; party stores those
  // separately so the extra fields are ignored there.
  const cur = state.puzzle && state.puzzle.current;
  try {
    ws.send(JSON.stringify({
      type: "position",
      fen: String(fen || ""),
      flipped: !!state.flipped,
      last_move: lastMoveStr,
      puzzle_id: cur ? String(cur.id || "") : "",
      puzzle_rating: cur ? Number(cur.rating || 0) : 0,
      streak: Number(state.puzzle ? state.puzzle.streak || 0 : 0),
      best_streak: Number(state.puzzle ? state.puzzle.bestStreak || 0 : 0),
      rating: Number(
        (state.user && state.user.rating)
        || (state.puzzle && state.puzzle.sessionRating)
        || 0
      ),
    }));
  } catch (_) { /* already closed */ }
}

// Reads `state.selectedSquare` + `state.legalTargets` and rebroadcasts
// them as a `select` message to spectators, deduped against the last
// payload (so calling this once per renderBoard is cheap). Computes
// the captures subset from the live chess instance (game / freeplay)
// so spectators can paint capture rings vs movement dots, mirroring
// the player's CSS.
function _partySyncSelectionFromState() {
  if (!_liveIsActive()) return;
  const sel = state.selectedSquare;
  if (!sel) {
    if (window.__partyLastSelectionSent === null) return;
    window.__partyLastSelectionSent = null;
    _partyReportSelection({ from: null, piece: null, legalMoves: [], legalCaptures: [] });
    return;
  }
  const targets = Array.isArray(state.legalTargets) ? state.legalTargets : [];
  let c = null;
  if (state.game && state.game.active) c = state.game.chess;
  else if (state.legalMode) c = state.freeplay && state.freeplay.chess;
  let pieceTag = null;
  let captures = [];
  if (c) {
    try {
      const p = c.get(sel);
      if (p) pieceTag = (p.color || "w") + (p.type || "p").toUpperCase();
      captures = targets.filter((sq) => {
        try { return !!c.get(sq); } catch (_) { return false; }
      });
    } catch (_) { /* ignore */ }
  }
  const key = `${sel}|${targets.join(",")}|${pieceTag}|${captures.join(",")}`;
  if (window.__partyLastSelectionSent === key) return;
  window.__partyLastSelectionSent = key;
  _partyReportSelection({
    from: sel,
    piece: pieceTag,
    legalMoves: targets,
    legalCaptures: captures,
  });
}

// Selection relay so spectators see the same legal-move hints the
// player sees. Sent on click-select, drag-start and on clear. We
// always include the player's chosen hint colour so the watcher's
// dots match what the player is looking at without a separate config
// roundtrip.
function _partyReportSelection({ from, piece, legalMoves, legalCaptures }) {
  const ws = _liveBroadcastWs();
  if (!ws) return;
  try {
    ws.send(JSON.stringify({
      type: "select",
      from: from || null,
      piece: piece || null,
      legal_moves: Array.isArray(legalMoves) ? legalMoves : [],
      legal_captures: Array.isArray(legalCaptures) ? legalCaptures : [],
      legal_color: _isHexColor(userSettings.legalDotColor)
        ? userSettings.legalDotColor
        : "",
    }));
  } catch (_) { /* already closed */ }
}

// Pointer relay so spectators can see what the player is doing
// between moves (cursor over a square, dragging a piece). Bandwidth:
// one JSON message every ~33ms while the cursor is over the board, so
// at most ~30 msgs/sec — small per-player.
let _cursorLastSendTs = 0;
let _cursorLastPayload = "";
// 4ms ~= 240 Hz. The browser only fires mousemove at the display's
// refresh rate (typically 60–240 Hz on modern setups), so we'll
// effectively send one frame per pointer event. Drag start/stop
// frames bypass the throttle so state changes are never lost.
const _CURSOR_THROTTLE_MS = 4;
function _partyReportCursor(payload) {
  const ws = _liveBroadcastWs();
  if (!ws) return;
  const now = Date.now();
  // Always send drag start/stop and explicit "leave" frames so we
  // don't get stuck with a stale dragging-flag on the spectator side.
  const isStateChange = payload.dragging || payload.x === null;
  if (!isStateChange && now - _cursorLastSendTs < _CURSOR_THROTTLE_MS) return;
  const serialized = JSON.stringify(payload);
  if (!isStateChange && serialized === _cursorLastPayload) return;
  _cursorLastSendTs = now;
  _cursorLastPayload = serialized;
  try {
    ws.send(JSON.stringify({ type: "cursor", ...payload }));
  } catch (_) { /* already closed */ }
}

function _installPartyCursorTracking() {
  if (window.__partyCursorInstalled) return;
  window.__partyCursorInstalled = true;
  const isPartyActive = () => _liveIsActive();
  const sample = (el, ev) => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const rawX = (ev.clientX - rect.left) / rect.width;
    const rawY = (ev.clientY - rect.top) / rect.height;
    // The local board may be flipped (black-on-bottom); spectators
    // always view from white-on-bottom, so undo the flip here.
    const flipped = !!state.flipped;
    const sx = flipped ? 1 - rawX : rawX;
    const sy = flipped ? 1 - rawY : rawY;
    return { x: sx, y: sy, flipped };
  };
  const onMove = (ev) => {
    if (!isPartyActive()) return;
    const board = document.querySelector(".board");
    if (!board) return;
    const s = sample(board, ev);
    if (!s) return;
    const sel = (typeof state.selectedSquare === "string") ? state.selectedSquare : "";
    _partyReportCursor({
      x: s.x,
      y: s.y,
      flipped: s.flipped,
      selected: sel,
      dragging: !!window.__partyCursorDragging,
      // Carry the piece + origin square so spectators can render the
      // dragged glyph at the cursor position. Cleared on dragend so
      // a stale icon never sticks around.
      drag_piece: window.__partyCursorDragging ? (window.__partyDragPiece || "") : "",
      drag_from: window.__partyCursorDragging ? (window.__partyDragFrom || "") : "",
    });
  };
  const onLeave = () => {
    if (!isPartyActive()) return;
    // Clear the cursor on spectator side by sending an out-of-bounds
    // position; the server clamps to [-0.05, 1.05] and the spectator
    // CSS hides the dot when outside the board.
    _partyReportCursor({
      x: -1, y: -1, flipped: false, selected: "", dragging: false,
      drag_piece: "", drag_from: "",
    });
  };
  const onDragStart = (ev) => {
    if (!isPartyActive()) return;
    window.__partyCursorDragging = true;
    // Identify the piece + origin square so spectators can render the
    // same floating glyph the player is dragging. dragstart can fire
    // on the .piece span itself, on a child img, or anywhere inside —
    // closest(".piece") handles all those cases. The .piece carries
    // dataset.piece (FEN char) and is a direct child of a .square
    // div whose dataset.square is "e2" / "h7" / etc.
    const pieceEl = ev && ev.target && ev.target.closest
      ? ev.target.closest(".piece")
      : null;
    if (pieceEl) {
      const fenChar = pieceEl.dataset && pieceEl.dataset.piece;
      const sqEl = pieceEl.closest(".square");
      const fromSq = (sqEl && sqEl.dataset && sqEl.dataset.square)
        || (pieceEl.dataset && pieceEl.dataset.fromSquare)
        || "";
      if (fenChar) {
        const color = fenChar === fenChar.toUpperCase() ? "w" : "b";
        window.__partyDragPiece = color + fenChar.toUpperCase();
      } else {
        window.__partyDragPiece = "";
      }
      window.__partyDragFrom = fromSq || "";
    } else {
      window.__partyDragPiece = "";
      window.__partyDragFrom = "";
    }
    // Push one frame immediately so spectators get the piece info as
    // soon as the drag starts, not on the next mousemove. Use cursor
    // coords from the event itself.
    const board = document.querySelector(".board");
    if (board) {
      const s = sample(board, ev);
      if (s) {
        const sel = (typeof state.selectedSquare === "string") ? state.selectedSquare : "";
        _partyReportCursor({
          x: s.x, y: s.y, flipped: s.flipped, selected: sel,
          dragging: true,
          drag_piece: window.__partyDragPiece || "",
          drag_from: window.__partyDragFrom || "",
        });
      }
    }
  };
  const onDragEnd = () => {
    if (!isPartyActive()) return;
    window.__partyCursorDragging = false;
    window.__partyDragPiece = "";
    window.__partyDragFrom = "";
    // Push one frame so spectators clear the floating piece + drag
    // flag immediately rather than waiting on the next mousemove.
    _partyReportCursor({
      x: -1, y: -1, flipped: false, selected: "",
      dragging: false, drag_piece: "", drag_from: "",
    });
  };
  document.addEventListener("mousemove", (ev) => {
    const board = document.querySelector(".board");
    if (!board) return;
    if (board === ev.target || board.contains(ev.target)) onMove(ev);
  }, { passive: true });
  document.addEventListener("mouseleave", onLeave, true);
  document.addEventListener("dragstart", onDragStart, true);
  document.addEventListener("dragend", onDragEnd, true);
  document.addEventListener("drop", onDragEnd, true);
  // The browser stops firing `mousemove` while an HTML5 drag is in
  // progress — pointer position then has to be sampled from the
  // `drag` event on the source piece, or from `dragover` on the
  // board (whichever has reliable clientX/clientY in this browser).
  // We listen to both so the spectator's cursor keeps tracking the
  // pointer mid-drag instead of freezing in place.
  document.addEventListener("drag", (ev) => {
    if (!isPartyActive()) return;
    if (typeof ev.clientX !== "number" || typeof ev.clientY !== "number") return;
    if (ev.clientX === 0 && ev.clientY === 0) return; // chromium "ghost" drag-end frame
    const board = document.querySelector(".board");
    if (!board) return;
    onMove(ev);
  }, { passive: true, capture: true });
  document.addEventListener("dragover", (ev) => {
    if (!isPartyActive()) return;
    const board = document.querySelector(".board");
    if (!board) return;
    if (board !== ev.target && !board.contains(ev.target)) return;
    onMove(ev);
  }, { passive: true, capture: true });
  // ---- Touch (phones) — mirror the dragstart/drag/dragend wires
  // above using clientX/clientY from the touch event so spectators
  // see the same cursor / drag piece info when the player is on a
  // phone. Skips multi-touch (pinch-zoom) and only fires when the
  // touch is over the board.
  const touchEvAdapter = (te) => {
    const t = (te.touches && te.touches[0])
      || (te.changedTouches && te.changedTouches[0])
      || null;
    if (!t) return null;
    return {
      clientX: t.clientX,
      clientY: t.clientY,
      target: te.target,
    };
  };
  document.addEventListener("touchstart", (ev) => {
    if (!isPartyActive()) return;
    if (ev.touches.length !== 1) return;
    const board = document.querySelector(".board");
    if (!board) return;
    const fake = touchEvAdapter(ev);
    if (!fake) return;
    if (board !== ev.target && !board.contains(ev.target)) return;
    // If the finger landed on a piece we mark drag-start so spectators
    // see the floating glyph; otherwise it's just a hover sample.
    const pieceEl = ev.target.closest && ev.target.closest(".piece");
    if (pieceEl) onDragStart(fake);
    else onMove(fake);
  }, { passive: true, capture: true });
  document.addEventListener("touchmove", (ev) => {
    if (!isPartyActive()) return;
    if (ev.touches.length !== 1) return;
    const board = document.querySelector(".board");
    if (!board) return;
    const fake = touchEvAdapter(ev);
    if (!fake) return;
    // We want cursor frames any time the finger is over the board,
    // even mid-drag, so spectators see the smooth path.
    onMove(fake);
  }, { passive: true, capture: true });
  document.addEventListener("touchend", () => {
    if (!isPartyActive()) return;
    if (window.__partyCursorDragging) onDragEnd();
    else onLeave();
  }, { passive: true, capture: true });
  document.addEventListener("touchcancel", () => {
    if (!isPartyActive()) return;
    if (window.__partyCursorDragging) onDragEnd();
  }, { passive: true, capture: true });
}
_installPartyCursorTracking();

function _partyDurationLabel(sec) {
  const n = Math.max(1, Math.round((Number(sec) || 0) / 60));
  return `${n} мин`;
}

function renderPartyLobby() {
  const body = _partyEnsureModal();
  if (!body) return;
  const m = state.party;
  const isHost = m.host_id === state.user.client_id;
  const memberRows = (m.members || []).map((mem) => `
    <li class="party-member ${mem.online ? "is-online" : "is-offline"}">
      <span class="party-avatar">${avatarHtml(mem.avatar)}</span>
      <span class="party-name">${escapeHtml(mem.nickname || "Гость")}</span>
      ${mem.is_host ? `<span class="party-tag party-tag-host">host</span>` : ""}
      ${!mem.online ? `<span class="party-tag party-tag-off">offline</span>` : ""}
    </li>
  `).join("");
  const startLabel = "Начать матч";
  const avgRatingPill = Number.isFinite(m.avgRating) && m.avgRating > 0
    ? `<span class="party-avg-pill" title="средний ELO лобби — под эту отметку подбираются пазлы">ср. ELO ${m.avgRating}</span>`
    : "";
  const livesN = Math.max(1, Math.floor(m.livesPerPlayer || 3));
  // Pre-fill the custom inputs with the current avg ±200 so the host
  // doesn't start from blank fields. We persist the host's last
  // selection via the inputs themselves on submit (no localStorage
  // round-trip — keep state on the server).
  const avgFloor = Math.max(400, (m.avgRating || 1200) - 200);
  const avgCeil  = Math.min(3000, (m.avgRating || 1200) + 200);
  const initialMode = (m.mode === "custom") ? "custom" : "standard";
  const initialMin = Number.isFinite(m.ratingMin) && m.ratingMin > 0 ? m.ratingMin : avgFloor;
  const initialMax = Number.isFinite(m.ratingMax) && m.ratingMax > 0 ? m.ratingMax : avgCeil;
  body.innerHTML = `
    <header class="party-header">
      <h2><span class="battle-h-icon" aria-hidden="true">${BATTLE_SWORDS_SVG}</span>Puzzle Battle — лобби</h2>
      <p class="muted">Код для приглашения: <code class="party-code-pill">${escapeHtml(m.code || "")}</code> ${avgRatingPill}</p>
    </header>
    <ul class="party-members">${memberRows || `<li class="party-empty">Пока никого…</li>`}</ul>
    <section class="party-rules">
      <div class="party-rule"><span class="party-rule-key">Длительность</span><span class="party-rule-val">3 мин</span></div>
      <div class="party-rule"><span class="party-rule-key">Жизни</span><span class="party-rule-val">${livesN}</span></div>
      <div class="party-rule party-rule-note">Матч заканчивается, когда живым остаётся один игрок — иначе по таймеру.</div>
    </section>
    ${isHost ? `
    <section class="party-mode-section">
      <div class="party-section-title">Режим пазлов</div>
      <div class="party-mode-row" role="radiogroup" aria-label="Режим пазлов">
        <label class="party-mode-opt ${initialMode === "standard" ? "is-active" : ""}">
          <input type="radio" name="party-mode" value="standard" ${initialMode === "standard" ? "checked" : ""}>
          <span class="party-mode-title">Стандартный</span>
          <span class="party-mode-hint">по среднему ELO лобби</span>
        </label>
        <label class="party-mode-opt ${initialMode === "custom" ? "is-active" : ""}">
          <input type="radio" name="party-mode" value="custom" ${initialMode === "custom" ? "checked" : ""}>
          <span class="party-mode-title">Кастомный</span>
          <span class="party-mode-hint">задай диапазон ELO вручную</span>
        </label>
      </div>
      <div id="party-custom-range" class="party-custom-range" ${initialMode === "custom" ? "" : "hidden"}>
        <label class="party-range-input">
          <span>От</span>
          <input id="party-rating-min" type="number" min="400" max="3000" step="10" value="${initialMin}" inputmode="numeric">
        </label>
        <label class="party-range-input">
          <span>До</span>
          <input id="party-rating-max" type="number" min="400" max="3000" step="10" value="${initialMax}" inputmode="numeric">
        </label>
        <div class="party-range-note muted">Ограничено 400–3000. Если вилка слишком узкая, пазлы добираются вокруг середины.</div>
      </div>
    </section>` : `
    <section class="party-mode-section party-mode-section-readonly">
      <div class="party-section-title">Режим пазлов</div>
      <div class="party-mode-readonly muted">${initialMode === "custom"
        ? `Кастом: ELO <strong>${initialMin}–${initialMax}</strong>`
        : `Стандартный (по среднему ELO лобби)`}</div>
    </section>`}
    ${isHost ? `
    <section class="party-invite-section">
      <div class="party-section-title">
        Пригласить друзей
        <button id="btn-party-invite-refresh" type="button" class="puzzle-ghost party-refresh-btn" title="Обновить">⟳</button>
      </div>
      <div id="party-friend-picker" class="party-friends">
        <div class="party-friend-empty">Загружаю список игроков…</div>
      </div>
    </section>` : ""}
    <div class="party-actions">
      ${isHost
        ? `<button id="btn-party-start" type="button" class="puzzle-primary">${escapeHtml(startLabel)}</button>`
        : `<div class="muted">Ждём, пока хост запустит матч…</div>`}
      <button id="btn-party-leave" type="button" class="puzzle-ghost">Выйти</button>
    </div>
    <div id="party-error" class="party-error" hidden></div>
  `;
  body.querySelector("#btn-party-leave")?.addEventListener("click", () => {
    leaveParty();
  });
  if (isHost) {
    _renderFriendPicker(m.code).catch(() => {});
    body.querySelector("#btn-party-invite-refresh")?.addEventListener("click", () => {
      _renderFriendPicker(m.code).catch(() => {});
    });
    // Mode toggle: show/hide rating inputs and keep label active state
    // in sync. We don't persist on every keypress — the values only
    // get sent on the "start" frame.
    const modeRadios = body.querySelectorAll('input[name="party-mode"]');
    const customBox = body.querySelector("#party-custom-range");
    modeRadios.forEach((radio) => {
      radio.addEventListener("change", () => {
        const mode = body.querySelector('input[name="party-mode"]:checked')?.value || "standard";
        body.querySelectorAll(".party-mode-opt").forEach((lbl) => {
          const r = lbl.querySelector('input[name="party-mode"]');
          lbl.classList.toggle("is-active", !!(r && r.checked));
        });
        if (customBox) customBox.hidden = mode !== "custom";
      });
    });
  }
  body.querySelector("#btn-party-start")?.addEventListener("click", (ev) => {
    const btn = ev.currentTarget;
    // Hard guard against the user clicking 'Start' multiple times
    // before the server's puzzle response arrives — extra sends were
    // ignored on the server, but the round-trip is long enough on a
    // big puzzle bank that the user can rack up several clicks. We
    // disable the button immediately and re-enable on error / leave.
    if (btn.disabled) return;
    const mode = body.querySelector('input[name="party-mode"]:checked')?.value || "standard";
    const startFrame = { type: "start", duration_sec: 180, mode };
    if (mode === "custom") {
      const rmin = parseInt(body.querySelector("#party-rating-min")?.value, 10);
      const rmax = parseInt(body.querySelector("#party-rating-max")?.value, 10);
      if (!Number.isFinite(rmin) || !Number.isFinite(rmax) || rmin <= 0 || rmax <= 0 || rmin >= rmax) {
        const err = body.querySelector("#party-error");
        if (err) {
          err.textContent = "Укажи корректный диапазон ELO (От < До, в пределах 400–3000).";
          err.hidden = false;
        }
        return;
      }
      startFrame.rating_min = Math.max(400, Math.min(3000, rmin));
      startFrame.rating_max = Math.max(400, Math.min(3000, rmax));
    }
    btn.disabled = true;
    btn.textContent = "Запускаем матч…";
    const ws = state.party.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(startFrame));
    } else {
      btn.disabled = false;
      btn.textContent = startLabel;
    }
  });
}

function leaveParty() {
  if (state.party.ws) {
    try { state.party.ws.send(JSON.stringify({ type: "leave" })); } catch (_) {}
    try { state.party.ws.close(); } catch (_) {}
  }
  state.party.active = false;
  state.party.ws = null;
  state.party.status = "lobby";
  if (state.party.countdownInterval) {
    clearInterval(state.party.countdownInterval);
    state.party.countdownInterval = null;
  }
  closePartyModal();
  _partyUnmountSidePanel();
  // Drop the party puzzle from solo state — without this, returning to
  // the puzzle tab would replay the exact same puzzle the user was on
  // when the match ended (because enterPuzzleView only fetches a fresh
  // one when state.puzzle.current is null).
  _stopPuzzleTimer();
  if (state.puzzle.pendingNext) {
    clearTimeout(state.puzzle.pendingNext);
    state.puzzle.pendingNext = null;
  }
  state.puzzle.current = null;
  state.puzzle.moves = [];
  state.puzzle.fenStart = null;
  state.puzzle.side = "w";
  state.puzzle.feedback = null;
  state.puzzle.attempts = 0;
  state.puzzle.hintUsed = false;
  state.puzzle.active = false;
  state.puzzle.startedAt = 0;
  state.puzzle.solveMs = 0;
  state.puzzle.nextIdx = 0;
  state.puzzle.needsNextOnReturn = true;
  // If the user is still on the puzzle tab when they leave, fetch a
  // fresh puzzle now so they don't sit on an empty board. Also restore
  // the solo-broadcast WS so they show up in the "Оффлайн" tab again.
  if (state.view === "puzzle") {
    state.puzzle.needsNextOnReturn = false;
    loadNextPuzzle();
    try { presenceConnect(); } catch (_) { /* ignore */ }
  }
}

function _partyStartCountdown() {
  if (state.party.countdownInterval) {
    clearInterval(state.party.countdownInterval);
  }
  state.party.countdownInterval = setInterval(_partyRenderHud, 1000);
  _partyRenderHud();
}

function _partyMountSidePanel() {
  let host = document.getElementById("party-side-panel");
  if (!host) {
    host = document.createElement("aside");
    host.id = "party-side-panel";
    host.className = "party-side-panel";
    document.body.appendChild(host);
  }
  // The slim HUD lives in the top-right; the full scoreboard mounts
  // **inside the puzzle panel** right under #puzzle-history so it
  // sits directly below the hint/skip row on the right column —
  // exactly where the user expects to see who's still alive without
  // taking their eyes off the puzzle card. We re-mount on every
  // call to make sure the panel survives view switches that may
  // have torn down the host element.
  let board = document.getElementById("party-board-panel");
  if (!board) {
    board = document.createElement("section");
    board.id = "party-board-panel";
    board.className = "party-board-panel";
  }
  // Pick the most appropriate mount point depending on the active
  // view. While we're on the "puzzle" view (default for a Battle
  // match) we tuck the panel under #puzzle-history so it inherits
  // the right-column flex layout. As a fallback (e.g. user wandered
  // off to Profile/Main mid-match) we attach to <body> so the panel
  // never disappears.
  const puzzlePanel = document.getElementById("panel-puzzle");
  const desiredParent = puzzlePanel || document.body;
  if (board.parentElement !== desiredParent) {
    desiredParent.appendChild(board);
  }
  return host;
}

function _partyUnmountSidePanel() {
  const host = document.getElementById("party-side-panel");
  if (host) host.remove();
  const board = document.getElementById("party-board-panel");
  if (board) board.remove();
}

function _partyRenderHud() {
  _partyRenderScoreboard();
}

// Build the chess.com-style streak grid for a single player. Renders
// as a horizontal strip of 10-tall vertical columns (one cell per
// attempt; green=solved, red=failed); a fresh column opens to the
// right of the previous one once the player completes 10 puzzles.
// Skipped puzzles are intentionally NOT painted — the user requested
// "решено / не решено" only.
function _partyStreakGridHtml(grid, livesMax) {
  const cells = Array.isArray(grid) ? grid : [];
  const colHeight = Math.max(2, Math.floor(state.party.gridColHeight || 10));
  // Always show at least one column even when the player hasn't
  // attempted anything yet, so the grid doesn't visually collapse to
  // nothing on the very first render.
  const columnCount = Math.max(1, Math.ceil(cells.length / colHeight) + (cells.length % colHeight === 0 ? 1 : 0));
  // Cap visible columns so a marathon player who somehow stacks 30
  // columns doesn't blow the side panel. Older columns scroll into
  // view via the wrapper's horizontal overflow.
  const VISIBLE_MAX_COLS = 6;
  const colsToRender = Math.min(columnCount, Math.max(1, VISIBLE_MAX_COLS));
  // Draw the most recent columns when there are more than fit; older
  // columns slide off the left edge so the player always sees their
  // current streak position.
  const startCol = Math.max(0, columnCount - colsToRender);
  let columnsHtml = "";
  for (let col = startCol; col < startCol + colsToRender; col += 1) {
    let cellsHtml = "";
    for (let row = 0; row < colHeight; row += 1) {
      const idx = col * colHeight + row;
      const v = cells[idx];
      let cls = "battle-streak-cell";
      if (v === true) cls += " is-solved";
      else if (v === false) cls += " is-failed";
      cellsHtml += `<span class="${cls}"></span>`;
    }
    columnsHtml += `<div class="battle-streak-col">${cellsHtml}</div>`;
  }
  void livesMax;
  return `<div class="battle-streak-grid">${columnsHtml}</div>`;
}

// "Lives" indicator: 3 squares (configurable) rendered green-checkmark
// when the player still has that life and red-X when they've spent
// it. Drains left-to-right.
function _partyLivesHtml(lives, livesMax) {
  const max = Math.max(1, Math.floor(livesMax || 3));
  const cur = Math.max(0, Math.min(max, Math.floor(Number(lives ?? max))));
  let html = "";
  for (let i = 0; i < max; i += 1) {
    const alive = i < cur;
    const cls = alive ? "battle-life is-alive" : "battle-life is-dead";
    const inner = alive
      ? `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`
      : `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>`;
    html += `<span class="${cls}">${inner}</span>`;
  }
  return `<div class="battle-lives">${html}</div>`;
}

function _partyRenderScoreboard() {
  const host = document.getElementById("party-side-panel");
  const board = document.getElementById("party-board-panel");
  if (!host && !board) return;
  const me = state.user.client_id;
  const livesMax = Math.max(1, Math.floor(state.party.livesPerPlayer || 3));
  const rowsList = (state.party.scoreboard || []).map((r, i) => {
    const livesRaw = (r.lives === undefined || r.lives === null) ? livesMax : r.lives;
    const livesHtml = _partyLivesHtml(livesRaw, r.lives_max || livesMax);
    const gridHtml = _partyStreakGridHtml(r.attempts_grid, r.lives_max || livesMax);
    const isSelf = r.client_id === me;
    const isOut = Number(livesRaw) <= 0;
    return `
      <li class="party-row battle-row ${isSelf ? "is-self" : ""} ${isOut ? "is-out" : ""}">
        <div class="battle-row-head">
          <span class="party-rank">#${i + 1}</span>
          <span class="party-avatar">${avatarHtml(r.avatar)}</span>
          <span class="party-name">${escapeHtml(r.nickname || "Гость")}${isSelf ? " <span class=\"battle-you\">(вы)</span>" : ""}</span>
          <span class="party-score">${Number(r.score || 0)}</span>
        </div>
        <div class="battle-row-body">
          ${livesHtml}
          ${gridHtml}
        </div>
      </li>
    `;
  }).join("");
  const timer = state.party.status === "playing"
    ? _formatPartyTimeLeft(state.party.endsAt)
    : (state.party.status === "finished" ? "0:00" : "3:00");
  const avgRating = Number.isFinite(state.party.avgRating) ? state.party.avgRating : 0;
  // The top-right HUD is intentionally slim per the redesign: only the
  // title, timer, and a single rating line (avg ELO for standard,
  // explicit window for custom). The full scoreboard moved to the
  // `.party-board-panel` rendered below the board so playing area
  // doesn't have a tall list overlapping the right-edge scale handle.
  let ratingLine = "";
  if (state.party.mode === "custom" && state.party.ratingMin > 0 && state.party.ratingMax > 0) {
    ratingLine = `<div class="party-side-avg" title="Кастомный диапазон рейтинга пазлов">ELO пазлов: <strong>${state.party.ratingMin}–${state.party.ratingMax}</strong></div>`;
  } else if (avgRating > 0) {
    ratingLine = `<div class="party-side-avg" title="Пазлы подбираются под этот лобби">ср. ELO лобби: <strong>${avgRating}</strong></div>`;
  }
  if (host) {
    host.innerHTML = `
      <header class="party-side-header">
        <span class="party-side-title"><span class="battle-h-icon" aria-hidden="true">${BATTLE_SWORDS_SVG}</span>Puzzle Battle</span>
        <span class="party-side-timer">${timer}</span>
      </header>
      ${ratingLine}
    `;
  }
  // Below-board scoreboard panel: full player list + leave button.
  // The hint/skip buttons live in the puzzle card directly under the
  // board (rendered by renderPuzzleUi) and are *not* duplicated here
  // — this panel only owns the multiplayer state.
  if (board) {
    board.innerHTML = `
      <ul class="party-side-list battle-rows">${rowsList || `<li class="party-empty">…</li>`}</ul>
      <button id="btn-party-leave-side" type="button" class="puzzle-ghost party-side-leave">Выйти из пати</button>
    `;
    board.querySelector("#btn-party-leave-side")?.addEventListener("click", leaveParty);
  }
}

// ---- Elimination modal ----

// When the server marks us out of lives we get an `eliminated` WS
// frame. We surface it as a modal that offers two paths:
//   1. "Смотреть матч"  → close modal, leave the party WS, open the
//      spectator session for the same party_id (existing flow), so
//      the user keeps watching the survivors until finish/timer.
//   2. "Остаться в лобби" → keep the modal closed, stay in the
//      already-locked board (no further dispatch). When the survivor
//      remains the server's `finish` frame will land us on the
//      results table the same as everyone else.
// The modal also self-dismisses on the next `finish` frame in case
// the user just sat there with it open.
function _partyHandleEliminated(msg) {
  state.party.selfEliminated = true;
  // Refresh the puzzle card so the hint/skip row is replaced with a
  // "you're out" notice — `renderPuzzleUi` reads `selfEliminated`.
  try { renderPuzzleUi(); } catch (_) {}
  try { _partyRenderScoreboard(); } catch (_) {}
  const partyId = (msg && msg.party_id) || state.party.party_id || "";
  const partyCode = state.party.code || "";
  const livesMax = Math.max(1, Math.floor(state.party.livesPerPlayer || 3));
  const solved = Number(msg && msg.solved) || 0;
  const failed = Number(msg && msg.failed) || 0;
  // Re-use the party modal element so we don't fork a new overlay
  // class. _partyEnsureModal returns the inner body container; the
  // modal itself is keyed by id `#party-modal`.
  const body = _partyEnsureModal({ useModal: true });
  if (!body) return;
  body.innerHTML = `
    <header class="party-header party-header-elim">
      <h2><span aria-hidden="true">⚔</span> Вы выбыли из матча</h2>
      <p class="muted">Кончились жизни (${livesMax}/${livesMax}). Решено: <strong>${solved}</strong>, ошибок: <strong>${failed}</strong>.</p>
      <p class="muted">Матч продолжается, пока остаётся хотя бы двое выживших — можно остаться и наблюдать.</p>
    </header>
    <div class="party-actions">
      <button id="btn-elim-spectate" type="button" class="puzzle-primary">Смотреть матч</button>
      <button id="btn-elim-stay" type="button" class="puzzle-ghost">Остаться в пати</button>
    </div>
  `;
  body.querySelector("#btn-elim-stay")?.addEventListener("click", () => {
    closePartyModal();
  });
  body.querySelector("#btn-elim-spectate")?.addEventListener("click", () => {
    closePartyModal();
    _partySwitchToSpectator();
  });
  void partyId;
}

// Drop the player WS and reattach as a spectator on the same party.
// Used by both the elim-modal "Смотреть матч" button and the inline
// "Смотреть матч" button in the puzzle card. We tear down the
// scoreboard panel first so it doesn't shadow the spectator UI.
function _partySwitchToSpectator() {
  const partyCode = state.party.code || "";
  try { state.party.ws && state.party.ws.close(); } catch (_) {}
  state.party.ws = null;
  state.party.active = false;
  state.party.status = "finished";
  state.party.selfEliminated = false;
  if (state.party.countdownInterval) {
    clearInterval(state.party.countdownInterval);
    state.party.countdownInterval = null;
  }
  _partyUnmountSidePanel();
  if (partyCode && typeof spectatorConnect === "function") {
    spectatorConnect(partyCode);
  }
}

function _partyDismissEliminatedModal() {
  // The elimination overlay reuses #party-modal; we only want to
  // close it if it's currently showing the elim header.
  const modal = document.getElementById("party-modal");
  if (!modal || modal.hidden) return;
  if (modal.querySelector(".party-header-elim")) {
    closePartyModal();
  }
}

function _formatPartyDuration(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  if (mm <= 0 && ss <= 0) return "—";
  if (ss === 0) return `${mm} мин`;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

function _formatSolveMs(ms) {
  const v = Math.max(0, Math.round(Number(ms) || 0));
  if (!v) return "—";
  if (v < 1000) return `${v} мс`;
  const sec = v / 1000;
  if (sec < 10) return `${sec.toFixed(1)} с`;
  return `${Math.round(sec)} с`;
}

// Build the detailed end-of-match scoreboard markup. The same renderer
// is reused by the live "Итоги пати" modal *and* by the per-battle
// detail modal opened from the profile, so the two views can never
// drift out of sync.
function _renderPartyResultsHTML(results, meta, opts) {
  const { highlightId = null, includeAttempts = false, attempts = null } = opts || {};
  const list = Array.isArray(results) ? results : [];
  const durationLabel = _formatPartyDuration(meta && meta.duration_sec);
  const startedAt = meta && (meta.ended_at || meta.started_at);
  const dateLabel = startedAt
    ? new Date(Number(startedAt) * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  const totals = list.reduce((acc, r) => {
    acc.solved += Number(r.solved || 0);
    acc.failed += Number(r.failed || 0);
    acc.skipped += Number(r.skipped || 0);
    return acc;
  }, { solved: 0, failed: 0, skipped: 0 });
  const totalAttempts = totals.solved + totals.failed + totals.skipped;
  const lobbyWin = totalAttempts ? (totals.solved / totalAttempts * 100) : 0;
  const headerMeta = `
    <div class="party-results-meta">
      <span><strong>${escapeHtml(durationLabel)}</strong> · длительность</span>
      <span><strong>${list.length}</strong> игроков</span>
      <span><strong>${totals.solved}</strong> решено / <strong>${totalAttempts}</strong> попыток</span>
      <span>Винрейт лобби: <strong>${lobbyWin.toFixed(1)}%</strong></span>
      ${dateLabel ? `<span class="muted">${escapeHtml(dateLabel)}</span>` : ""}
    </div>`;
  const tableRows = list.map((r) => {
    const isSelf = highlightId && r.client_id === highlightId;
    const winrate = Number(r.winrate || 0);
    const avg = _formatSolveMs(r.avg_solve_ms);
    const best = _formatSolveMs(r.best_solve_ms);
    return `
      <tr class="party-results-row ${isSelf ? "is-self" : ""}">
        <td class="party-rank">#${Number(r.rank || 0)}</td>
        <td class="party-results-player">
          <span class="party-avatar">${avatarHtml(r.avatar)}</span>
          <span class="party-name">${escapeHtml(r.nickname || "Гость")}${isSelf ? " <span class=\"muted\" style=\"font-size:11px;\">(вы)</span>" : ""}</span>
        </td>
        <td class="party-results-num party-score">${Number(r.score || 0)}</td>
        <td class="party-results-num ok">${Number(r.solved || 0)}</td>
        <td class="party-results-num bad">${Number(r.failed || 0)}</td>
        <td class="party-results-num warn">${Number(r.skipped || 0)}</td>
        <td class="party-results-num">${winrate.toFixed(1)}%</td>
        <td class="party-results-num warn">🔥 ${Number(r.best_streak || 0)}</td>
        <td class="party-results-num muted">${avg} / ${best}</td>
      </tr>`;
  }).join("");
  const tableHtml = `
    <div class="party-results-tablewrap">
      <table class="party-results-table">
        <thead>
          <tr>
            <th class="col-rank">#</th>
            <th class="col-player">Игрок</th>
            <th class="col-num">Очки</th>
            <th class="col-num">✔</th>
            <th class="col-num">✘</th>
            <th class="col-num">↷</th>
            <th class="col-num">Винрейт</th>
            <th class="col-num">Серия</th>
            <th class="col-time">Ср. / лучшее</th>
          </tr>
        </thead>
        <tbody>${tableRows || `<tr><td colspan="9" class="party-empty">Никто ничего не решил.</td></tr>`}</tbody>
      </table>
    </div>`;
  let attemptsHtml = "";
  if (includeAttempts && Array.isArray(attempts) && attempts.length) {
    const attemptRows = attempts.slice(-50).reverse().map((a, idx) => {
      const outcome = String(a.outcome || "skipped");
      const cls = outcome === "solved" ? "ok" : (outcome === "failed" ? "bad" : "warn");
      const sym = outcome === "solved" ? "✔" : (outcome === "failed" ? "✘" : "↷");
      const themes = Array.isArray(a.themes) ? a.themes.slice(0, 3).join(" · ") : "";
      const score = Number(a.score || 0);
      return `
        <tr>
          <td class="party-results-num muted">${attempts.length - idx}</td>
          <td><span class="party-results-attempt-id">#${escapeHtml(String(a.puzzle_id || ""))}</span></td>
          <td class="party-results-num">${Number(a.rating || 0)}</td>
          <td class="party-results-num ${cls}">${sym}</td>
          <td class="party-results-num">${_formatSolveMs(a.solve_ms)}</td>
          <td class="party-results-num">${score > 0 ? `+${score}` : score}</td>
          <td class="muted">${escapeHtml(themes)}</td>
        </tr>`;
    }).join("");
    attemptsHtml = `
      <details class="party-results-attempts" open>
        <summary>Ваши попытки (${attempts.length})</summary>
        <div class="party-results-tablewrap">
          <table class="party-results-table party-results-attempts-table">
            <thead>
              <tr>
                <th>#</th><th>Пазл</th><th>Эло</th><th>Итог</th><th>Время</th><th>Очки</th><th>Темы</th>
              </tr>
            </thead>
            <tbody>${attemptRows}</tbody>
          </table>
        </div>
      </details>`;
  }
  return `${headerMeta}${tableHtml}${attemptsHtml}`;
}

// Render the results card to a PNG via canvas, then trigger a
// download. We draw text manually instead of leaning on a third-party
// html-to-image lib to keep the frontend dependency-free.
async function _partySaveResultsAsImage(results, meta, fileName) {
  const list = Array.isArray(results) ? results : [];
  const W = 1100;
  const headerH = 130;
  const rowH = 56;
  const footerH = 80;
  const tableTop = headerH + 60;
  const H = headerH + 60 + Math.max(rowH * (list.length + 1), rowH) + footerH;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  // Background.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "#1f2a3a");
  grad.addColorStop(1, "#161e2c");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // Border.
  ctx.strokeStyle = "#2c3950";
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);
  // Header.
  ctx.fillStyle = "#e7eef9";
  ctx.font = "bold 36px system-ui, sans-serif";
  ctx.fillText("🏁 Итоги пати", 32, 56);
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillStyle = "#94a4be";
  const durationLabel = _formatPartyDuration(meta && meta.duration_sec);
  const startedAt = meta && (meta.ended_at || meta.started_at);
  const dateLabel = startedAt
    ? new Date(Number(startedAt) * 1000).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
  ctx.fillText(`Длительность: ${durationLabel}   ·   Игроков: ${list.length}${dateLabel ? `   ·   ${dateLabel}` : ""}`, 32, 90);
  // Table headers.
  const cols = [
    { x: 32,  w: 60,  label: "#",       align: "left" },
    { x: 100, w: 320, label: "Игрок",   align: "left" },
    { x: 430, w: 90,  label: "Очки",    align: "right" },
    { x: 530, w: 60,  label: "✔",        align: "right" },
    { x: 600, w: 60,  label: "✘",        align: "right" },
    { x: 670, w: 60,  label: "↷",        align: "right" },
    { x: 740, w: 100, label: "Винрейт", align: "right" },
    { x: 850, w: 90,  label: "Серия",   align: "right" },
    { x: 950, w: 120, label: "Эло",     align: "right" },
  ];
  ctx.fillStyle = "#94a4be";
  ctx.font = "bold 14px system-ui, sans-serif";
  for (const c of cols) {
    ctx.textAlign = c.align;
    const tx = c.align === "right" ? c.x + c.w : c.x;
    ctx.fillText(c.label, tx, tableTop - 14);
  }
  // Rows.
  ctx.font = "16px system-ui, sans-serif";
  list.forEach((r, idx) => {
    const y = tableTop + idx * rowH;
    if (idx % 2 === 0) {
      ctx.fillStyle = "rgba(26, 37, 56, 0.55)";
      ctx.fillRect(24, y - 4, W - 48, rowH);
    }
    const winrate = Number(r.winrate || 0);
    const elo = Number(r.party_elo || 0);
    const eloLabel = elo > 0 ? `+${elo}` : `${elo}`;
    const cellY = y + 28;
    const draws = [
      { c: cols[0], v: `#${Number(r.rank || 0)}`,                  color: "#94a4be" },
      { c: cols[1], v: `${(r.avatar || "♟")}  ${(r.nickname || "Гость")}`, color: "#e7eef9" },
      { c: cols[2], v: `${Number(r.score || 0)}`,                  color: "#6da7ff" },
      { c: cols[3], v: `${Number(r.solved || 0)}`,                 color: "#6cf2a6" },
      { c: cols[4], v: `${Number(r.failed || 0)}`,                 color: "#ffb1bf" },
      { c: cols[5], v: `${Number(r.skipped || 0)}`,                color: "#ffd75e" },
      { c: cols[6], v: `${winrate.toFixed(1)}%`,                   color: "#e7eef9" },
      { c: cols[7], v: `🔥 ${Number(r.best_streak || 0)}`,          color: "#ffd75e" },
      { c: cols[8], v: eloLabel,                                   color: "#ffd75e" },
    ];
    for (const d of draws) {
      ctx.fillStyle = d.color;
      ctx.textAlign = d.c.align;
      const tx = d.c.align === "right" ? d.c.x + d.c.w : d.c.x;
      ctx.fillText(d.v, tx, cellY);
    }
  });
  // Footer.
  ctx.textAlign = "left";
  ctx.fillStyle = "#6da7ff";
  ctx.font = "italic 13px system-ui, sans-serif";
  ctx.fillText("chess-sandbox · party puzzles", 32, H - 24);
  // Trigger download.
  const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
  if (!blob) return false;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName || `party-${meta && meta.party_id ? meta.party_id : Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  // Best-effort native share (mobile etc) so the same button drops an
  // image into Telegram / Photos / etc when supported.
  try {
    const file = new File([blob], a.download, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: "Итоги пати", text: "Мой результат в puzzle-party 🏆" });
    }
  } catch (_) { /* user cancelled / unsupported */ }
  return true;
}

function _formatPartyShareText(results, meta) {
  const list = Array.isArray(results) ? results : [];
  const lines = list.slice(0, 10).map((r) => {
    const winrate = Number(r.winrate || 0).toFixed(1);
    return `#${r.rank} ${r.avatar || "♟"} ${r.nickname || "Гость"} — ${Number(r.score || 0)} pts (${Number(r.solved || 0)} ✔ / ${winrate}%)`;
  });
  const durationLabel = _formatPartyDuration(meta && meta.duration_sec);
  return [
    `🏁 Итоги пати (${durationLabel})`,
    ...lines,
    "chess-sandbox",
  ].join("\n");
}

function _partyShareToTelegram(results, meta) {
  const text = _formatPartyShareText(results, meta);
  const url = location.origin || "https://chess-sandbox.app";
  const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  // Try the Web Share API first (works inside Telegram WebView and on
  // most mobile browsers); fall back to the t.me share URL.
  if (navigator.share) {
    navigator.share({ title: "Итоги пати", text, url }).catch(() => {
      window.open(shareUrl, "_blank", "noopener");
    });
  } else {
    window.open(shareUrl, "_blank", "noopener");
  }
}

// Discord doesn't expose a public "share to Discord" intent the way
// Telegram does (no t.me/share equivalent), so the most reliable
// cross-platform path is: copy a formatted snippet to clipboard and
// open Discord (web or desktop via the discord:// scheme) so the user
// can paste straight into the channel of their choice.
async function _partyShareToDiscord(results, meta, btn) {
  const text = _formatPartyShareText(results, meta);
  const url = location.origin || "https://chess-sandbox.app";
  const payload = `${text}\n${url}`;
  let copied = false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(payload);
      copied = true;
    }
  } catch (_) { /* clipboard blocked — fall through to manual */ }
  if (!copied) {
    try {
      const ta = document.createElement("textarea");
      ta.value = payload;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      copied = document.execCommand("copy");
      ta.remove();
    } catch (_) { /* ignore */ }
  }
  // Open Discord so the user can paste. Fire the desktop URL scheme
  // first (no-op on machines without Discord installed), then fall
  // back to the web client in a new tab.
  try { window.open("https://discord.com/channels/@me", "_blank", "noopener"); } catch (_) {}
  if (btn) {
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = copied ? "✔ Скопировано — вставь в Discord" : "Не удалось скопировать";
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 2400);
  } else {
    _showInfoToast(copied ? "Скопировано — вставь в Discord" : "Не удалось скопировать");
  }
  return copied;
}

function _partyShowResults() {
  // The match just ended (or we're rendering the post-match snapshot
  // after re-entering Battle). If the user was peeking at another tab
  // when the timer ran out, force a switch back to Battle so the
  // results panel actually mounts somewhere visible — otherwise the
  // table renders into `#battle-body` while another view sits on top
  // of it and nothing pops up at all.
  if (state.view !== "battle") {
    try { setView("battle"); } catch (_) { /* fall through */ }
  }
  const body = _partyEnsureModal({ results: true, useModal: state.view !== "battle" });
  if (!body) return;
  _partyUnmountSidePanel();
  const list = Array.isArray(state.party.finalResults) ? state.party.finalResults : [];
  const meta = state.party.finalMeta || {
    duration_sec: state.party.durationSec || 600,
    started_at: state.party.startedAt || 0,
    ended_at: Math.floor(Date.now() / 1000),
    party_id: state.party.party_id || "",
  };
  state.party.finalMeta = meta;
  const myCid = state.user.client_id;
  const tableHtml = _renderPartyResultsHTML(list, meta, { highlightId: myCid });
  body.innerHTML = `
    <header class="party-header">
      <h2>🏁 Итоги пати</h2>
      <p class="muted">Результат сохранён в истории профиля. Рейтинг за пати не начисляется.</p>
    </header>
    <div class="party-results-card">${tableHtml}</div>
    <div class="party-actions party-actions-results">
      <button id="btn-party-save-img" type="button" class="puzzle-secondary">📷 Сохранить в галерею</button>
      <button id="btn-party-share-discord" type="button" class="puzzle-secondary">💬 Поделиться в Discord</button>
      <button id="btn-party-share-tg" type="button" class="puzzle-secondary">✈️ Поделиться в Telegram</button>
      <button id="btn-party-close-results" type="button" class="puzzle-primary">Закрыть</button>
    </div>
  `;
  body.querySelector("#btn-party-save-img")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = "Сохраняю…";
    try {
      const ok = await _partySaveResultsAsImage(list, meta, `party-${meta.party_id || Date.now()}.png`);
      btn.textContent = ok ? "✓ Сохранено" : "Не удалось сохранить";
    } catch (_) {
      btn.textContent = "Не удалось сохранить";
    } finally {
      setTimeout(() => { btn.textContent = originalText; btn.disabled = false; }, 1800);
    }
  });
  body.querySelector("#btn-party-share-tg")?.addEventListener("click", () => {
    _partyShareToTelegram(list, meta);
  });
  body.querySelector("#btn-party-share-discord")?.addEventListener("click", (ev) => {
    _partyShareToDiscord(list, meta, ev.currentTarget);
  });
  body.querySelector("#btn-party-close-results")?.addEventListener("click", () => {
    closePartyModal();
    state.party.ws = null;
    state.party.status = "lobby";
    state.party.finalResults = null;
    state.party.finalMeta = null;
  });
}

// Open the persisted party-summary view from a profile history click.
// `entry` is a single record from `user.parties[]` as written by the
// backend in `Party.finish()`. Falls back to the per-user fields when
// the older shape (no `results` array) is encountered, so legacy
// matches still get a usable detail screen.
// `opts.ownerId/Nickname/Avatar` are passed when opening the log of
// another user (leaderboard → friend's profile → history row), so the
// fallback row identifies the actual owner instead of the viewer.
function openPartyResultDetail(entry, opts) {
  if (!entry || typeof entry !== "object") return;
  // Always render into the legacy `#party-modal` overlay — this entry
  // point is fired from the profile modal (or a leaderboard popup), so
  // the side-panel host (`#battle-body`) is sitting under another view
  // and writing to it produced a visibly empty modal frame instead of
  // the table.
  const body = _partyEnsureModal({ results: true, useModal: true });
  if (!body) return;
  const ownerId = (opts && opts.ownerId) || state.user.client_id;
  const ownerNickname = (opts && opts.ownerNickname) || state.user.nickname || "Гость";
  const ownerAvatar = (opts && opts.ownerAvatar) || state.user.avatar || "♟";
  const meta = {
    duration_sec: Number(entry.duration_sec) || 0,
    started_at: Number(entry.started_at) || Number(entry.ts) || 0,
    ended_at: Number(entry.ended_at) || Number(entry.ts) || 0,
    party_id: String(entry.party_id || ""),
  };
  // Reconstruct a minimal scoreboard if the backend didn't send one
  // (legacy entries) so the detail modal still opens with usable data.
  const fallbackResults = [{
    rank: Number(entry.placement || 1),
    client_id: ownerId,
    nickname: ownerNickname,
    avatar: ownerAvatar,
    score: Number(entry.score || 0),
    solved: Number(entry.solved || 0),
    failed: Number(entry.failed || 0),
    skipped: Number(entry.skipped || 0),
    winrate: Number(entry.winrate || 0),
    best_streak: Number(entry.best_streak || 0),
    avg_solve_ms: Number(entry.avg_solve_ms || 0),
    best_solve_ms: Number(entry.best_solve_ms || 0),
  }];
  const list = Array.isArray(entry.results) && entry.results.length
    ? entry.results
    : fallbackResults;
  // Only include the per-attempt log when viewing your own history;
  // other users' attempts aren't persisted for them server-side.
  const isOwnHistory = ownerId === state.user.client_id;
  const tableHtml = _renderPartyResultsHTML(list, meta, {
    highlightId: ownerId,
    includeAttempts: isOwnHistory,
    attempts: isOwnHistory && Array.isArray(entry.attempts) ? entry.attempts : null,
  });
  body.innerHTML = `
    <header class="party-header">
      <h2>📜 Подробный результат боя</h2>
      <p class="muted">#${Number(entry.placement || 1)} из ${Number(entry.participants || list.length)} · ${escapeHtml(_formatPartyDuration(meta.duration_sec))}${isOwnHistory ? "" : ` · ${escapeHtml(ownerNickname)}`}</p>
    </header>
    <div class="party-results-card">${tableHtml}</div>
    <div class="party-actions party-actions-results">
      <button id="btn-party-detail-save" type="button" class="puzzle-secondary">📷 Сохранить в галерею</button>
      <button id="btn-party-detail-share-discord" type="button" class="puzzle-secondary">💬 Поделиться в Discord</button>
      <button id="btn-party-detail-share" type="button" class="puzzle-secondary">✈️ Поделиться в Telegram</button>
      <button id="btn-party-detail-close" type="button" class="puzzle-primary">Закрыть</button>
    </div>
  `;
  document.getElementById("party-modal").hidden = false;
  body.querySelector("#btn-party-detail-save")?.addEventListener("click", async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "Сохраняю…";
    try {
      const ok = await _partySaveResultsAsImage(list, meta, `party-${meta.party_id || meta.started_at || Date.now()}.png`);
      btn.textContent = ok ? "✓ Сохранено" : "Не удалось сохранить";
    } catch (_) {
      btn.textContent = "Не удалось сохранить";
    } finally {
      setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1800);
    }
  });
  body.querySelector("#btn-party-detail-share")?.addEventListener("click", () => {
    _partyShareToTelegram(list, meta);
  });
  body.querySelector("#btn-party-detail-share-discord")?.addEventListener("click", (ev) => {
    _partyShareToDiscord(list, meta, ev.currentTarget);
  });
  body.querySelector("#btn-party-detail-close")?.addEventListener("click", () => {
    closePartyModal();
  });
}

// Expose so profile rows can call it through inline onclick fallbacks.
window.openPartyResultDetail = openPartyResultDetail;

// ---------- Daily Puzzle / Puzzle Rush / Opening Trainer ----------
//
// All three views share the same board the puzzle view uses. They
// each install their own move-dispatch handler in `tryFreeplayMove`
// (legal-mode forced on so drops route through us), wire their own
// "card" / "actions" / "history" containers in the right sidebar,
// and persist the user-facing stats via /api/users/* helpers.

const STARTPOS_FEN_FALLBACK = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
function _startposFen() {
  try { return STARTPOS_FEN; } catch (_) { return STARTPOS_FEN_FALLBACK; }
}

function _puzzleViewSnapshotFlipped(slot) {
  if (state[slot].flippedSnapshot === null) {
    state[slot].flippedSnapshot = state.flipped;
  }
}
function _puzzleViewRestoreFlipped(slot) {
  if (state[slot].flippedSnapshot !== null
      && state.flipped !== state[slot].flippedSnapshot) {
    state.flipped = state[slot].flippedSnapshot;
  }
  state[slot].flippedSnapshot = null;
}

function _puzzleResetBoardCommon() {
  state.bestArrow = null;
  state.bestPv = null;
  state.reviewBadge = null;
  state.lastMove = null;
  try { loadFen(_startposFen()); } catch (_) { /* ignore */ }
  renderBoard();
}

function _flashSquare(sq, cls) {
  const cell = boardEl && boardEl.querySelector(`.square[data-square="${sq}"]`);
  if (!cell) return;
  cell.classList.add(cls);
  setTimeout(() => cell.classList.remove(cls), 600);
}

function _fmtMmSs(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// =================== Daily Puzzle =====================

const DAILY_LS_KEY = "cs.daily.session";

function _loadDailySession() {
  try {
    const raw = localStorage.getItem(DAILY_LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      if (typeof data.streak === "number") state.daily.streak = data.streak;
      if (typeof data.bestStreak === "number") state.daily.bestStreak = data.bestStreak;
    }
  } catch (_) { /* ignore */ }
}

function _saveDailySession() {
  try {
    localStorage.setItem(DAILY_LS_KEY, JSON.stringify({
      streak: state.daily.streak,
      bestStreak: state.daily.bestStreak,
    }));
  } catch (_) { /* ignore */ }
}

function _hydrateDailyFromUser(u) {
  if (!u || typeof u !== "object") return;
  const dp = (u.stats && u.stats.daily_puzzle) || u.daily_puzzle;
  if (!dp || typeof dp !== "object") return;
  if (typeof dp.streak === "number")      state.daily.streak = dp.streak;
  if (typeof dp.best_streak === "number") state.daily.bestStreak = dp.best_streak;
  if (typeof dp.last_solved_date === "string") {
    const today = _todayUtcIso();
    if (dp.last_solved_date === today) state.daily.solvedToday = true;
  }
  _saveDailySession();
}

function _todayUtcIso() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
}

async function enterDailyView() {
  _puzzleViewSnapshotFlipped("daily");
  if (!state.legalMode) setBoardMode(true);
  _loadDailySession();
  // Always (re)fetch leaderboard.
  _refreshDailyLeaderboard();
  if (!state.daily.current) {
    await _loadDailyPuzzle();
  } else if (state.daily.active) {
    // Restore the in-progress board (idempotent).
    _restoreDailyBoard();
    renderDailyUi();
  } else {
    renderDailyUi();
  }
}

function leaveDailyView() {
  _stopDailyTimer();
  if (state.daily.pendingNext) {
    clearTimeout(state.daily.pendingNext);
    state.daily.pendingNext = null;
  }
  _puzzleViewRestoreFlipped("daily");
  _puzzleResetBoardCommon();
}

async function _loadDailyPuzzle() {
  const card = document.getElementById("daily-card");
  if (card) card.innerHTML = `<div class="puzzle-empty">Загружаем сегодняшний пазл…</div>`;
  let p;
  try {
    p = await api(`/api/daily_puzzle/today`);
  } catch (err) {
    if (card) card.innerHTML = `<div class="puzzle-empty">Не удалось загрузить пазл: ${escapeHtml(String(err && err.message || err))}</div>`;
    return;
  }
  state.daily.current = p;
  state.daily.moves = Array.isArray(p.moves) ? p.moves.slice() : [];
  state.daily.fenStart = p.fen;
  state.daily.side = p.side_to_solve || "w";
  state.daily.active = false;     // user must press Start
  state.daily.feedback = null;
  state.daily.attemptsToday = 0;
  state.daily.startedAt = 0;
  state.daily.solveMs = 0;
  state.daily.failed = false;
  // If the user has a heartbeat that says they already solved today,
  // preserve solvedToday — otherwise reset.
  renderDailyUi();
}

async function _refreshDailyLeaderboard() {
  try {
    const r = await api(`/api/daily_puzzle/leaderboard?limit=20`);
    state.daily.leaderboard = Array.isArray(r.rows) ? r.rows : [];
  } catch (_) {
    state.daily.leaderboard = [];
  }
  renderDailyLeaderboard();
}

function _startDailyTimer() {
  _stopDailyTimer();
  state.daily.timerHandle = setInterval(_paintDailyTimer, 500);
  _paintDailyTimer();
}
function _stopDailyTimer() {
  if (state.daily.timerHandle) {
    clearInterval(state.daily.timerHandle);
    state.daily.timerHandle = null;
  }
}
function _paintDailyTimer() {
  const el = document.getElementById("daily-timer-val");
  if (!el) return;
  const ms = state.daily.startedAt
    ? (state.daily.solveMs || (Date.now() - state.daily.startedAt))
    : 0;
  el.textContent = _fmtMmSs(ms);
}

function _restoreDailyBoard() {
  if (!state.daily.current) return;
  try { loadFen(state.daily.fenStart); } catch (_) { return; }
  const c = ensureFreeplayChess();
  if (!c) return;
  for (let i = 0; i < state.daily.nextIdx; i++) {
    const u = state.daily.moves[i];
    if (!u || u.length < 4) break;
    try {
      c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" });
    } catch { break; }
  }
  loadFen(c.fen());
  const wantFlipped = state.daily.side === "b";
  if (state.flipped !== wantFlipped) state.flipped = wantFlipped;
  renderBoard();
}

function startDailyPuzzle() {
  if (!state.daily.current) return;
  state.daily.active = true;
  state.daily.feedback = null;
  state.daily.failed = false;
  state.daily.nextIdx = 0;
  state.daily.startedAt = 0;
  state.daily.solveMs = 0;
  try { loadFen(state.daily.fenStart); } catch (_) { return; }
  const wantFlipped = state.daily.side === "b";
  if (state.flipped !== wantFlipped) state.flipped = wantFlipped;
  renderBoard();
  renderDailyUi();
  setTimeout(() => _playDailySetupMove(), 220);
}

function _playDailySetupMove() {
  if (!state.daily.active || !state.daily.current) return;
  const u = state.daily.moves[0];
  if (!u || u.length < 4) return;
  const c = ensureFreeplayChess();
  if (!c) return;
  let move;
  try { move = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); } catch { move = null; }
  if (!move) return;
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  renderBoard();
  playMoveSoundFor(move, { isOwn: false, inCheck: c.isCheck() });
  state.daily.nextIdx = 1;
  state.daily.startedAt = Date.now();
  _startDailyTimer();
  renderDailyUi();
}

function tryDailyMove(from, to) {
  if (!state.daily.active) return;
  const c = ensureFreeplayChess();
  if (!c) return;
  const moveTo = freeplayCastlingTarget(c, from, to) || to;
  let move;
  try { move = c.move({ from, to: moveTo, promotion: "q" }); } catch { move = null; }
  if (!move) {
    setStatus("Нелегальный ход.", "error");
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
    return;
  }
  const playedUci = move.from + move.to + (move.promotion || "");
  const expected = state.daily.moves[state.daily.nextIdx] || "";
  const sameMove = playedUci === expected
    || (expected.length >= 4
        && playedUci.slice(0, 4) === expected.slice(0, 4)
        && (expected.length === 4 || playedUci.slice(4) === expected.slice(4)));
  if (!sameMove) {
    try { c.undo(); } catch (_) { /* ignore */ }
    state.daily.attemptsToday += 1;
    state.selectedSquare = null;
    state.legalTargets = [];
    _flashSquare(move.to, "puzzle-flash-bad");
    state.daily.feedback = "wrong";
    renderBoard();
    renderDailyUi();
    return;
  }
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  state.daily.feedback = "correct";
  state.daily.nextIdx += 1;
  renderBoard();
  renderDailyUi();
  playMoveSoundFor(move, { isOwn: true, inCheck: c.isCheck() });
  _flashSquare(move.to, "puzzle-flash-ok");
  if (state.daily.nextIdx >= state.daily.moves.length) {
    finalizeDailyPuzzle("solved");
    return;
  }
  setTimeout(() => _playDailyOpponentReply(), 220);
}

function _playDailyOpponentReply() {
  if (!state.daily.active) return;
  const u = state.daily.moves[state.daily.nextIdx];
  if (!u || u.length < 4) return;
  const c = ensureFreeplayChess();
  if (!c) return;
  let move;
  try { move = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); } catch { move = null; }
  if (!move) return;
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  renderBoard();
  playMoveSoundFor(move, { isOwn: false, inCheck: c.isCheck() });
  state.daily.nextIdx += 1;
  state.daily.feedback = null;
  renderDailyUi();
  if (state.daily.nextIdx >= state.daily.moves.length) {
    finalizeDailyPuzzle("solved");
  }
}

async function finalizeDailyPuzzle(result) {
  state.daily.active = false;
  _stopDailyTimer();
  state.daily.solveMs = state.daily.startedAt ? (Date.now() - state.daily.startedAt) : 0;
  if (result === "solved") {
    state.daily.solvedToday = true;
    state.daily.feedback = "solved";
    spawnPuzzleCelebration("ok");
  } else {
    state.daily.failed = true;
    state.daily.feedback = "shown";
    spawnPuzzleCelebration("bad");
  }
  renderDailyUi();
  // Submit to backend.
  const u = state.user;
  if (u && u.client_id && state.daily.current) {
    try {
      const updated = await api(`/api/daily_puzzle/attempt`, {
        method: "POST",
        body: JSON.stringify({
          client_id: u.client_id,
          date: state.daily.current.date || _todayUtcIso(),
          puzzle_id: String(state.daily.current.id || ""),
          outcome: result === "solved" ? "solved" : "failed",
          solve_ms: state.daily.solveMs,
        }),
      });
      _hydrateDailyFromUser(updated);
    } catch (_) { /* ignore */ }
  }
  _refreshDailyLeaderboard();
  renderDailyUi();
}

function _surrenderDailyPuzzle() {
  if (!state.daily.active) return;
  finalizeDailyPuzzle("failed");
}

function renderDailyUi() {
  renderDailyStatsBar();
  renderDailyLeaderboard();
  const card = document.getElementById("daily-card");
  const actions = document.getElementById("daily-actions");
  if (!card || !actions) return;
  const p = state.daily.current;
  if (!p) {
    card.innerHTML = `<div class="puzzle-empty">Загружаем сегодняшний пазл…</div>`;
    actions.innerHTML = "";
    return;
  }
  const themes = (p.themes_ru || p.themes || []).slice(0, 4)
    .map((t) => `<span class="puzzle-theme-pill">${escapeHtml(t)}</span>`).join("");
  const sideTxt = state.daily.side === "b" ? "чёрные" : "белые";
  let banner = "";
  if (state.daily.feedback === "solved") {
    banner = `<div class="puzzle-banner puzzle-banner-ok">Решено! Вернись завтра — будет новый пазл.</div>`;
  } else if (state.daily.feedback === "shown") {
    banner = `<div class="puzzle-banner puzzle-banner-bad">Не получилось. Попробуй вернуться завтра.</div>`;
  } else if (state.daily.feedback === "wrong") {
    banner = `<div class="puzzle-banner puzzle-banner-bad">Неверно. Попробуй ещё.</div>`;
  } else if (state.daily.feedback === "correct") {
    banner = `<div class="puzzle-banner puzzle-banner-ok">Хороший ход!</div>`;
  }
  card.innerHTML = `
    <div class="puzzle-meta">
      <div class="puzzle-id">Daily · ${escapeHtml(p.date || _todayUtcIso())}</div>
      <div class="puzzle-rating">★ ${p.rating || "—"}</div>
    </div>
    <div class="puzzle-themes">${themes}</div>
    <div class="puzzle-side">Ход за <b>${sideTxt}</b>.</div>
    ${banner}
  `;
  if (!state.daily.active && !state.daily.solvedToday && !state.daily.failed) {
    actions.innerHTML = `<button id="btn-daily-start" type="button" class="puzzle-primary">Начать</button>`;
    const btn = document.getElementById("btn-daily-start");
    if (btn) btn.onclick = startDailyPuzzle;
  } else if (state.daily.active) {
    actions.innerHTML = `<button id="btn-daily-give-up" type="button" class="puzzle-secondary">Сдаться</button>`;
    const btn = document.getElementById("btn-daily-give-up");
    if (btn) btn.onclick = _surrenderDailyPuzzle;
  } else {
    actions.innerHTML = `<button id="btn-daily-replay" type="button" class="puzzle-secondary" disabled>Завтра новый пазл</button>`;
  }
}

function renderDailyStatsBar() {
  const host = document.getElementById("daily-stats-bar");
  if (!host) return;
  const ms = state.daily.startedAt
    ? (state.daily.solveMs || (Date.now() - state.daily.startedAt))
    : 0;
  host.innerHTML = `
    <div class="ps-block ps-streak">
      <span class="ps-label">Серия дней</span>
      <span class="ps-val ${state.daily.streak >= 3 ? "ok" : ""}">🔥 ${state.daily.streak}</span>
    </div>
    <div class="ps-divider"></div>
    <div class="ps-block">
      <span class="ps-label">Лучший</span>
      <span class="ps-val">${state.daily.bestStreak}</span>
    </div>
    <div class="ps-divider"></div>
    <div class="ps-block ps-timer">
      <span class="ps-label">Время</span>
      <span class="ps-val" id="daily-timer-val">${_fmtMmSs(ms)}</span>
    </div>
  `;
}

function renderDailyLeaderboard() {
  const host = document.getElementById("daily-leaderboard");
  if (!host) return;
  const rows = state.daily.leaderboard || [];
  if (!rows.length) {
    host.innerHTML = `<div class="puzzle-empty">Пока никто не решил. Будь первым!</div>`;
    return;
  }
  const items = rows.slice(0, 20).map((r, i) => {
    const av = avatarHtml(r.avatar);
    const nick = escapeHtml(r.nickname || "Гость");
    const ms = typeof r.solve_ms === "number" ? r.solve_ms : 0;
    const att = typeof r.attempts === "number" ? r.attempts : 0;
    const tag = att <= 1 ? "" : ` <span class="muted">×${att}</span>`;
    return `<div class="lb-row">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-av">${av}</span>
      <span class="lb-nick">${nick}</span>
      <span class="lb-time">${_fmtMmSs(ms)}${tag}</span>
    </div>`;
  }).join("");
  host.innerHTML = `<div class="lb-title">Лидерборд сегодня</div>${items}`;
}

// =================== Puzzle Rush =====================

const RUSH_LS_KEY = "cs.rush.session";
const RUSH_FETCH_BATCH = 6; // pre-fetch this many at a time

function _loadRushSession() {
  try {
    const raw = localStorage.getItem(RUSH_LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data === "object") {
      if (data.bestEver && typeof data.bestEver === "object") {
        state.rush.bestEver = { ...state.rush.bestEver, ...data.bestEver };
      }
      if (data.bestToday && typeof data.bestToday === "object" && data.bestToday._date === _todayUtcIso()) {
        const { _date, ...vals } = data.bestToday;
        state.rush.bestToday = { ...state.rush.bestToday, ...vals };
      }
    }
  } catch (_) { /* ignore */ }
}

function _saveRushSession() {
  try {
    localStorage.setItem(RUSH_LS_KEY, JSON.stringify({
      bestEver: state.rush.bestEver,
      bestToday: { ...state.rush.bestToday, _date: _todayUtcIso() },
    }));
  } catch (_) { /* ignore */ }
}

function _hydrateRushFromUser(u) {
  if (!u || typeof u !== "object") return;
  const pr = (u.stats && u.stats.puzzle_rush) || u.puzzle_rush;
  if (!pr || typeof pr !== "object") return;
  const today = _todayUtcIso();
  for (const m of ["180", "300", "survival"]) {
    const slot = pr[m];
    if (slot && typeof slot === "object") {
      if (typeof slot.best_ever === "number") {
        state.rush.bestEver[m] = Math.max(state.rush.bestEver[m] || 0, slot.best_ever);
      }
      if (typeof slot.best_today === "number" && slot.best_today_date === today) {
        state.rush.bestToday[m] = Math.max(state.rush.bestToday[m] || 0, slot.best_today);
      }
    }
  }
  _saveRushSession();
}

const RUSH_MODE_LABEL = { "180": "3 минуты", "300": "5 минут", "survival": "Survival" };

async function enterRushView() {
  _puzzleViewSnapshotFlipped("rush");
  if (!state.legalMode) setBoardMode(true);
  _loadRushSession();
  _refreshRushLeaderboard();
  if (!state.rush.active && !state.rush.finished) {
    renderRushUi();
  } else if (state.rush.active && state.rush.current) {
    _restoreRushBoard();
    renderRushUi();
    _startRushTimer();
  } else {
    renderRushUi();
  }
}

function leaveRushView() {
  _stopRushTimer();
  _puzzleViewRestoreFlipped("rush");
  _puzzleResetBoardCommon();
}

function _resetRushSession() {
  _stopRushTimer();
  state.rush.active = false;
  state.rush.finished = false;
  state.rush.finishReason = null;
  state.rush.score = 0;
  state.rush.mistakes = 0;
  state.rush.queue = [];
  state.rush.fetchedTotal = 0;
  state.rush.current = null;
  state.rush.moves = [];
  state.rush.nextIdx = 0;
  state.rush.side = null;
  state.rush.fenStart = null;
  state.rush.startedAt = 0;
  state.rush.deadlineAt = 0;
  state.rush.durationSec = 0;
  state.rush.history = [];
  state.rush.sessionId = null;
  state.rush.mode = null;
}

async function startRush(mode) {
  if (!["180", "300", "survival"].includes(mode)) return;
  _resetRushSession();
  state.rush.mode = mode;
  state.rush.durationSec = mode === "180" ? 180 : (mode === "300" ? 300 : 0);
  state.rush.deadlineAt = state.rush.durationSec ? (Date.now() + state.rush.durationSec * 1000) : 0;
  state.rush.startedAt = Date.now();
  state.rush.active = true;
  // Notify backend (best-effort) for session id and bookkeeping.
  const u = state.user;
  if (u && u.client_id) {
    try {
      const r = await api(`/api/puzzle_rush/start`, {
        method: "POST",
        body: JSON.stringify({
          client_id: u.client_id,
          mode: mode === "180" ? "3min" : (mode === "300" ? "5min" : "survival"),
        }),
      });
      if (r && r.session_id) state.rush.sessionId = r.session_id;
    } catch (_) { /* ignore */ }
  }
  renderRushUi();
  await _refillRushQueue();
  _startRushTimer();
  _serveNextRushPuzzle();
}

async function _refillRushQueue() {
  if (state.rush.queue.length >= 2) return;
  const params = new URLSearchParams();
  params.set("min_rating", "800");
  params.set("max_rating", "2400");
  params.set("count", String(RUSH_FETCH_BATCH));
  try {
    const r = await api(`/api/puzzle/random?${params.toString()}`);
    let arr;
    if (Array.isArray(r)) arr = r;
    else if (r && Array.isArray(r.puzzles)) arr = r.puzzles;
    else if (r && typeof r === "object") arr = [r];
    else arr = [];
    for (const p of arr) {
      if (p && p.fen && Array.isArray(p.moves) && p.moves.length >= 2) {
        state.rush.queue.push(p);
        state.rush.fetchedTotal += 1;
      }
    }
  } catch (_) { /* ignore */ }
  // If the API doesn't support count param, fall back to single-fetch loop.
  if (state.rush.queue.length === 0) {
    for (let i = 0; i < 2; i++) {
      try {
        const p = await api(`/api/puzzle/random?min_rating=800&max_rating=2400`);
        if (p && p.fen && Array.isArray(p.moves) && p.moves.length >= 2) {
          state.rush.queue.push(p);
          state.rush.fetchedTotal += 1;
        }
      } catch (_) { /* ignore */ }
    }
  }
}

function _serveNextRushPuzzle() {
  if (!state.rush.active) return;
  if (state.rush.queue.length === 0) {
    // Fetch and try again.
    _refillRushQueue().then(() => _serveNextRushPuzzle());
    return;
  }
  const p = state.rush.queue.shift();
  // Pre-fetch the next batch in the background as we go.
  if (state.rush.queue.length < 2) {
    _refillRushQueue();
  }
  state.rush.current = p;
  state.rush.moves = p.moves.slice();
  state.rush.fenStart = p.fen;
  state.rush.side = p.side_to_solve || "w";
  state.rush.nextIdx = 0;
  try { loadFen(p.fen); } catch (_) { return; }
  const wantFlipped = state.rush.side === "b";
  if (state.flipped !== wantFlipped) state.flipped = wantFlipped;
  renderBoard();
  renderRushUi();
  setTimeout(() => _playRushSetupMove(), 200);
}

function _playRushSetupMove() {
  if (!state.rush.active || !state.rush.current) return;
  const u = state.rush.moves[0];
  if (!u || u.length < 4) return;
  const c = ensureFreeplayChess();
  if (!c) return;
  let move;
  try { move = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); } catch { move = null; }
  if (!move) return;
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  renderBoard();
  playMoveSoundFor(move, { isOwn: false, inCheck: c.isCheck() });
  state.rush.nextIdx = 1;
}

function _restoreRushBoard() {
  if (!state.rush.current) return;
  try { loadFen(state.rush.fenStart); } catch (_) { return; }
  const c = ensureFreeplayChess();
  if (!c) return;
  for (let i = 0; i < state.rush.nextIdx; i++) {
    const u = state.rush.moves[i];
    if (!u || u.length < 4) break;
    try { c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); } catch { break; }
  }
  loadFen(c.fen());
  renderBoard();
}

function tryRushMove(from, to) {
  if (!state.rush.active || !state.rush.current) return;
  const c = ensureFreeplayChess();
  if (!c) return;
  const moveTo = freeplayCastlingTarget(c, from, to) || to;
  let move;
  try { move = c.move({ from, to: moveTo, promotion: "q" }); } catch { move = null; }
  if (!move) {
    setStatus("Нелегальный ход.", "error");
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
    return;
  }
  const playedUci = move.from + move.to + (move.promotion || "");
  const expected = state.rush.moves[state.rush.nextIdx] || "";
  const sameMove = playedUci === expected
    || (expected.length >= 4
        && playedUci.slice(0, 4) === expected.slice(0, 4)
        && (expected.length === 4 || playedUci.slice(4) === expected.slice(4)));
  if (!sameMove) {
    try { c.undo(); } catch (_) { /* ignore */ }
    state.selectedSquare = null;
    state.legalTargets = [];
    _flashSquare(move.to, "puzzle-flash-bad");
    state.rush.mistakes += 1;
    state.rush.history.unshift({
      id: state.rush.current.id,
      rating: state.rush.current.rating,
      outcome: "failed",
      solveMs: 0,
    });
    _reportRushAttempt({ outcome: "failed", solve_ms: 0 });
    renderBoard();
    if (state.rush.mistakes >= state.rush.maxMistakes) {
      finishRush("mistakes");
      return;
    }
    renderRushUi();
    // Move on to next puzzle.
    setTimeout(() => _serveNextRushPuzzle(), 380);
    return;
  }
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  state.rush.nextIdx += 1;
  renderBoard();
  playMoveSoundFor(move, { isOwn: true, inCheck: c.isCheck() });
  _flashSquare(move.to, "puzzle-flash-ok");
  if (state.rush.nextIdx >= state.rush.moves.length) {
    state.rush.score += 1;
    state.rush.history.unshift({
      id: state.rush.current.id,
      rating: state.rush.current.rating,
      outcome: "solved",
      solveMs: 0,
    });
    _reportRushAttempt({ outcome: "solved", solve_ms: 0 });
    renderRushUi();
    setTimeout(() => _serveNextRushPuzzle(), 280);
    return;
  }
  // Forced opponent reply.
  setTimeout(() => _playRushOpponentReply(), 180);
}

function _playRushOpponentReply() {
  if (!state.rush.active) return;
  const u = state.rush.moves[state.rush.nextIdx];
  if (!u || u.length < 4) return;
  const c = ensureFreeplayChess();
  if (!c) return;
  let move;
  try { move = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] || "q" }); } catch { move = null; }
  if (!move) return;
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  renderBoard();
  playMoveSoundFor(move, { isOwn: false, inCheck: c.isCheck() });
  state.rush.nextIdx += 1;
  if (state.rush.nextIdx >= state.rush.moves.length) {
    state.rush.score += 1;
    state.rush.history.unshift({
      id: state.rush.current.id,
      rating: state.rush.current.rating,
      outcome: "solved",
      solveMs: 0,
    });
    _reportRushAttempt({ outcome: "solved", solve_ms: 0 });
    renderRushUi();
    setTimeout(() => _serveNextRushPuzzle(), 220);
  }
}

async function _reportRushAttempt({ outcome, solve_ms }) {
  const u = state.user;
  if (!u || !u.client_id || !state.rush.sessionId || !state.rush.current) return;
  try {
    await api(`/api/puzzle_rush/attempt`, {
      method: "POST",
      body: JSON.stringify({
        session_id: state.rush.sessionId,
        client_id: u.client_id,
        puzzle_id: String(state.rush.current.id || ""),
        outcome,
        solve_ms: solve_ms || 0,
      }),
    });
  } catch (_) { /* ignore */ }
}

function _startRushTimer() {
  _stopRushTimer();
  state.rush.timerHandle = setInterval(_paintRushTimer, 250);
  _paintRushTimer();
}
function _stopRushTimer() {
  if (state.rush.timerHandle) {
    clearInterval(state.rush.timerHandle);
    state.rush.timerHandle = null;
  }
}
function _paintRushTimer() {
  if (!state.rush.active) return;
  if (state.rush.deadlineAt && Date.now() >= state.rush.deadlineAt) {
    finishRush("time");
    return;
  }
  const el = document.getElementById("rush-timer-val");
  if (!el) return;
  if (state.rush.deadlineAt) {
    el.textContent = _fmtMmSs(Math.max(0, state.rush.deadlineAt - Date.now()));
  } else if (state.rush.startedAt) {
    el.textContent = _fmtMmSs(Date.now() - state.rush.startedAt);
  }
}

async function finishRush(reason) {
  if (state.rush.finished) return;
  state.rush.finished = true;
  state.rush.active = false;
  state.rush.finishReason = reason || "user-stop";
  _stopRushTimer();
  // Update best counters.
  const m = state.rush.mode;
  if (m) {
    state.rush.bestToday[m] = Math.max(state.rush.bestToday[m] || 0, state.rush.score);
    state.rush.bestEver[m]  = Math.max(state.rush.bestEver[m]  || 0, state.rush.score);
    _saveRushSession();
  }
  // Finalize on backend.
  const u = state.user;
  if (u && u.client_id && state.rush.sessionId) {
    try {
      const r = await api(`/api/puzzle_rush/finalize`, {
        method: "POST",
        body: JSON.stringify({
          session_id: state.rush.sessionId,
          client_id: u.client_id,
        }),
      });
      _hydrateRushFromUser(r && r.user ? r.user : r);
    } catch (_) { /* ignore */ }
  }
  spawnPuzzleCelebration(state.rush.score > 0 ? "ok" : "bad");
  _refreshRushLeaderboard();
  renderRushUi();
}

async function _refreshRushLeaderboard() {
  const m = state.rush.leaderboardMode;
  const period = state.rush.leaderboardScope;
  const apiMode = m === "180" ? "3min" : (m === "300" ? "5min" : "survival");
  try {
    const r = await api(`/api/puzzle_rush/leaderboard?mode=${apiMode}&period=${period}&limit=20`);
    state.rush.leaderboard[m] = Array.isArray(r.rows) ? r.rows : [];
  } catch (_) {
    state.rush.leaderboard[m] = [];
  }
  renderRushLeaderboard();
}

function renderRushUi() {
  renderRushStatsBar();
  renderRushHistory();
  renderRushLeaderboard();
  const card = document.getElementById("rush-card");
  const actions = document.getElementById("rush-actions");
  if (!card || !actions) return;
  if (!state.rush.mode || (!state.rush.active && !state.rush.finished)) {
    // Mode picker.
    card.innerHTML = `
      <div class="rush-pick">
        <h3>Выбери режим</h3>
        <div class="rush-pick-grid">
          <button type="button" class="rush-mode-btn" data-mode="180">
            <span class="rush-mode-label">3 минуты</span>
            <span class="rush-mode-sub">Best today: ${state.rush.bestToday["180"] || 0} · OAT: ${state.rush.bestEver["180"] || 0}</span>
          </button>
          <button type="button" class="rush-mode-btn" data-mode="300">
            <span class="rush-mode-label">5 минут</span>
            <span class="rush-mode-sub">Best today: ${state.rush.bestToday["300"] || 0} · OAT: ${state.rush.bestEver["300"] || 0}</span>
          </button>
          <button type="button" class="rush-mode-btn" data-mode="survival">
            <span class="rush-mode-label">Survival</span>
            <span class="rush-mode-sub">До 3 ошибок · OAT: ${state.rush.bestEver["survival"] || 0}</span>
          </button>
        </div>
        <p class="muted">3 ошибки — конец сессии. Лидерборд: лучший рекорд за сегодня и за всё время.</p>
      </div>
    `;
    actions.innerHTML = "";
    card.querySelectorAll(".rush-mode-btn").forEach((b) => {
      b.onclick = () => startRush(b.dataset.mode);
    });
    return;
  }
  if (state.rush.finished) {
    const reasonTxt = state.rush.finishReason === "time"
      ? "Время вышло."
      : state.rush.finishReason === "mistakes"
      ? "Достигнут предел ошибок."
      : "Сессия завершена.";
    card.innerHTML = `
      <div class="rush-result">
        <h3>Результат: ${state.rush.score}</h3>
        <p class="muted">${reasonTxt} Режим: ${RUSH_MODE_LABEL[state.rush.mode]}.</p>
        <div class="rush-bests">
          <span>Best today: <b>${state.rush.bestToday[state.rush.mode] || 0}</b></span>
          <span>OAT: <b>${state.rush.bestEver[state.rush.mode] || 0}</b></span>
        </div>
      </div>
    `;
    actions.innerHTML = `
      <button id="btn-rush-restart" type="button" class="puzzle-primary">Ещё раз</button>
      <button id="btn-rush-pick" type="button" class="puzzle-secondary">Сменить режим</button>
    `;
    document.getElementById("btn-rush-restart").onclick = () => startRush(state.rush.mode);
    document.getElementById("btn-rush-pick").onclick = () => { _resetRushSession(); renderRushUi(); };
    return;
  }
  const p = state.rush.current;
  card.innerHTML = `
    <div class="rush-running">
      <div class="puzzle-meta">
        <div class="puzzle-id">Rush · ${escapeHtml(RUSH_MODE_LABEL[state.rush.mode])}</div>
        <div class="puzzle-rating">★ ${p ? (p.rating || "—") : "—"}</div>
      </div>
      <div class="rush-stats">
        <span>Решено: <b>${state.rush.score}</b></span>
        <span>Ошибки: <b class="${state.rush.mistakes >= 2 ? "rush-bad" : ""}">${state.rush.mistakes}/${state.rush.maxMistakes}</b></span>
      </div>
    </div>
  `;
  actions.innerHTML = `<button id="btn-rush-stop" type="button" class="puzzle-secondary">Стоп</button>`;
  const stop = document.getElementById("btn-rush-stop");
  if (stop) stop.onclick = () => finishRush("user-stop");
}

function renderRushStatsBar() {
  const host = document.getElementById("rush-stats-bar");
  if (!host) return;
  const remain = state.rush.deadlineAt ? Math.max(0, state.rush.deadlineAt - Date.now()) : 0;
  const elapsed = state.rush.startedAt ? (Date.now() - state.rush.startedAt) : 0;
  const t = state.rush.deadlineAt ? remain : elapsed;
  host.innerHTML = `
    <div class="ps-block">
      <span class="ps-label">Решено</span>
      <span class="ps-val">${state.rush.score}</span>
    </div>
    <div class="ps-divider"></div>
    <div class="ps-block">
      <span class="ps-label">Ошибки</span>
      <span class="ps-val ${state.rush.mistakes >= 2 ? "bad" : ""}">${state.rush.mistakes}/${state.rush.maxMistakes}</span>
    </div>
    <div class="ps-divider"></div>
    <div class="ps-block ps-timer">
      <span class="ps-label">${state.rush.deadlineAt ? "Осталось" : "Время"}</span>
      <span class="ps-val" id="rush-timer-val">${_fmtMmSs(t)}</span>
    </div>
  `;
}

function renderRushHistory() {
  const host = document.getElementById("rush-history");
  if (!host) return;
  const items = state.rush.history.slice(0, 12);
  if (!items.length) { host.innerHTML = ""; return; }
  host.innerHTML = items.map((h) => {
    const cls = h.outcome === "solved" ? "h-ok" : "h-bad";
    const glyph = h.outcome === "solved" ? "✓" : "✕";
    return `<span class="puzzle-history-pill ${cls}" title="#${escapeHtml(String(h.id))} · ${h.rating || "—"}">${glyph} ${h.rating || "—"}</span>`;
  }).join("");
}

function renderRushLeaderboard() {
  const host = document.getElementById("rush-leaderboard");
  if (!host) return;
  const m = state.rush.leaderboardMode;
  const rows = state.rush.leaderboard[m] || [];
  const tabs = ["180", "300", "survival"].map((mm) => {
    const active = mm === m ? " is-active" : "";
    return `<button type="button" class="lb-tab${active}" data-mode="${mm}">${RUSH_MODE_LABEL[mm]}</button>`;
  }).join("");
  const scope = state.rush.leaderboardScope;
  const scopeTabs = ["today", "alltime"].map((s) => {
    const active = s === scope ? " is-active" : "";
    return `<button type="button" class="lb-tab${active}" data-scope="${s}">${s === "today" ? "Сегодня" : "Все время"}</button>`;
  }).join("");
  let body;
  if (!rows.length) {
    body = `<div class="puzzle-empty">Лидерборд пуст. Сыграй первым!</div>`;
  } else {
    body = rows.slice(0, 20).map((r, i) => {
      const av = avatarHtml(r.avatar);
      const nick = escapeHtml(r.nickname || "Гость");
      const score = r.score != null ? r.score : (r.best || 0);
      return `<div class="lb-row">
        <span class="lb-rank">${i + 1}</span>
        <span class="lb-av">${av}</span>
        <span class="lb-nick">${nick}</span>
        <span class="lb-score">${score}</span>
      </div>`;
    }).join("");
  }
  host.innerHTML = `
    <div class="lb-title">Лидерборд</div>
    <div class="lb-tabs">${tabs}</div>
    <div class="lb-tabs lb-tabs-scope">${scopeTabs}</div>
    ${body}
  `;
  host.querySelectorAll(".lb-tab[data-mode]").forEach((b) => {
    b.onclick = () => { state.rush.leaderboardMode = b.dataset.mode; _refreshRushLeaderboard(); };
  });
  host.querySelectorAll(".lb-tab[data-scope]").forEach((b) => {
    b.onclick = () => { state.rush.leaderboardScope = b.dataset.scope; _refreshRushLeaderboard(); };
  });
}

// =================== Opening Trainer =====================

const OPENING_LS_KEY = "cs.opening.session";

function _loadOpeningSession() {
  try {
    const raw = localStorage.getItem(OPENING_LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && typeof data === "object" && data.mastery) {
      state.opening.mastery = { ...data.mastery };
    }
  } catch (_) { /* ignore */ }
}
function _saveOpeningSession() {
  try {
    localStorage.setItem(OPENING_LS_KEY, JSON.stringify({
      mastery: state.opening.mastery,
    }));
  } catch (_) { /* ignore */ }
}
function _hydrateOpeningFromUser(u) {
  if (!u || typeof u !== "object") return;
  const ot = (u.stats && u.stats.opening_trainer) || u.opening_trainer;
  if (!ot || typeof ot !== "object") return;
  for (const [k, v] of Object.entries(ot)) {
    if (v && typeof v === "object") {
      state.opening.mastery[k] = { ...state.opening.mastery[k], ...v };
    }
  }
  _saveOpeningSession();
}

// ---------- Battle (Puzzle Battle) view ----------
//
// The Battle tab is the new home of the former "Party" feature: the
// lobby chooser, lobby itself, live scoreboard and post-match results
// all render inside `#battle-body`. enterBattleView dispatches to
// whichever sub-view the local party state implies.
async function enterBattleView() {
  if (!state.user.client_id) {
    const host = document.getElementById("battle-body");
    if (host) {
      host.innerHTML = `<div class="puzzle-empty">Зайди как игрок, чтобы создавать пати и принимать инвайты.</div>`;
    }
    return;
  }
  if (state.party.active && state.party.status === "lobby") {
    renderPartyLobby();
    return;
  }
  if (state.party.active && state.party.status === "playing") {
    _partyMountSidePanel();
    _partyRenderScoreboard();
    return;
  }
  if (state.party.status === "finished" && Array.isArray(state.party.finalResults) && state.party.finalResults.length) {
    _partyShowResults();
    return;
  }
  // Default: render the lobby chooser (open parties / create / invite codes).
  openPartyModal();
}

function leaveBattleView() {
  // Nothing to tear down — the panel is hidden by CSS view scoping.
  // Hide the legacy modal in case some legacy code path opened it.
  const m = document.getElementById("party-modal");
  if (m) m.hidden = true;
}

async function enterOpeningView() {
  _puzzleViewSnapshotFlipped("opening");
  if (!state.legalMode) setBoardMode(true);
  _loadOpeningSession();
  if (!state.opening.catalog.length) {
    try {
      const r = await api(`/api/opening_trainer/list`);
      state.opening.catalog = Array.isArray(r.openings) ? r.openings : [];
    } catch (_) {
      state.opening.catalog = [];
    }
  }
  _resetOpeningBoard();
  renderOpeningUi();
}

function leaveOpeningView() {
  _puzzleViewRestoreFlipped("opening");
  _puzzleResetBoardCommon();
}

function _selectedOpening() {
  return state.opening.catalog.find((o) => o.id === state.opening.selectedId) || null;
}
function _selectedOpeningLine() {
  const op = _selectedOpening();
  if (!op || !Array.isArray(op.lines)) return null;
  return op.lines.find((l) => l.id === state.opening.selectedLineId)
    || op.lines[0] || null;
}

function _resetOpeningBoard() {
  state.opening.chess = null;
  state.opening.moveIdx = 0;
  state.opening.feedback = null;
  state.opening.coachMsg = "";
  state.opening.lastWrongSan = "";
  try { loadFen(_startposFen()); } catch (_) { /* ignore */ }
  state.lastMove = null;
  renderBoard();
}

function selectOpening(openingId, lineId) {
  state.opening.selectedId = openingId;
  state.opening.selectedLineId = lineId || null;
  state.opening.active = false;
  _resetOpeningBoard();
  // Auto-flip board if line is for black.
  const op = _selectedOpening();
  if (op && op.color === "black") {
    if (!state.flipped) { state.flipped = true; renderBoard(); }
  } else {
    if (state.flipped) { state.flipped = false; renderBoard(); }
  }
  renderOpeningUi();
}

function setOpeningMode(mode) {
  state.opening.mode = mode;
  if (mode === "practice") {
    startOpeningPractice();
  } else {
    state.opening.active = false;
    _resetOpeningBoard();
    renderOpeningUi();
  }
}

function startOpeningPractice() {
  const line = _selectedOpeningLine();
  if (!line) return;
  state.opening.chess = new Chess();
  state.opening.moveIdx = 0;
  state.opening.feedback = null;
  state.opening.coachMsg = "Сделай первый ход по теории дебюта.";
  state.opening.active = true;
  try { loadFen(state.opening.chess.fen()); } catch (_) { /* ignore */ }
  state.lastMove = null;
  renderBoard();
  // If the line starts with the opponent's move, play it for them.
  const op = _selectedOpening();
  if (op && op.color === "black") {
    setTimeout(() => _playOpeningOpponentMove(), 280);
  }
  renderOpeningUi();
}

function _playOpeningOpponentMove() {
  if (!state.opening.active) return;
  const line = _selectedOpeningLine();
  if (!line) return;
  if (state.opening.moveIdx >= line.moves.length) {
    _completeOpeningLine();
    return;
  }
  const expectedSan = line.moves[state.opening.moveIdx];
  const c = state.opening.chess;
  if (!c) return;
  let move;
  try { move = c.move(expectedSan, { sloppy: true }); } catch { move = null; }
  if (!move) return;
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  renderBoard();
  playMoveSoundFor(move, { isOwn: false, inCheck: c.isCheck() });
  state.opening.moveIdx += 1;
  state.opening.coachMsg = `Соперник: ${move.san}. Твой ход.`;
  if (state.opening.moveIdx >= line.moves.length) {
    _completeOpeningLine();
  }
  renderOpeningUi();
}

function tryOpeningMove(from, to) {
  if (!state.opening.active || !state.opening.chess) {
    setStatus("Нажми Практика чтобы начать.", "error");
    return;
  }
  const c = state.opening.chess;
  const moveTo = freeplayCastlingTarget(c, from, to) || to;
  let move;
  try { move = c.move({ from, to: moveTo, promotion: "q" }); } catch { move = null; }
  if (!move) {
    setStatus("Нелегальный ход.", "error");
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
    return;
  }
  const line = _selectedOpeningLine();
  const expected = line && line.moves[state.opening.moveIdx];
  // Compare via SAN (allow chess.js to normalise).
  if (!expected || move.san !== expected) {
    // Wrong move. We snapshot the user's actual SAN before undoing so
    // the AI coach can ask Stockfish for the precise cp loss versus
    // the theory move (otherwise the verdict can only say «не теория»
    // without knowing how bad it was).
    state.opening.lastWrongSan = move.san || "";
    try { c.undo(); } catch (_) { /* ignore */ }
    state.opening.feedback = "wrong";
    state.opening.coachMsg = expected
      ? `Не лучший ход. По теории здесь: ${expected}.`
      : `Линия закончилась.`;
    _flashSquare(move.to, "puzzle-flash-bad");
    state.selectedSquare = null;
    state.legalTargets = [];
    renderBoard();
    _reportOpeningAttempt(false, false);
    renderOpeningUi();
    return;
  }
  // Correct.
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  renderBoard();
  playMoveSoundFor(move, { isOwn: true, inCheck: c.isCheck() });
  _flashSquare(move.to, "puzzle-flash-ok");
  state.opening.moveIdx += 1;
  state.opening.feedback = "correct";
  state.opening.coachMsg = `Верно: ${move.san}.`;
  if (state.opening.moveIdx >= line.moves.length) {
    _completeOpeningLine();
    return;
  }
  // Opponent reply.
  setTimeout(() => _playOpeningOpponentMove(), 280);
}

function _completeOpeningLine() {
  state.opening.active = false;
  state.opening.feedback = "complete";
  state.opening.coachMsg = "Линия пройдена! Отличная работа.";
  spawnPuzzleCelebration("ok");
  _reportOpeningAttempt(true, true);
  renderOpeningUi();
}

async function _reportOpeningAttempt(correct, lineCompleted) {
  const u = state.user;
  if (!u || !u.client_id) return;
  const op = _selectedOpening();
  const line = _selectedOpeningLine();
  if (!op || !line) return;
  const ply = state.opening.moveIdx;
  try {
    const san = (line.moves[Math.max(0, ply - 1)] || "");
    const r = await api(`/api/opening_trainer/attempt`, {
      method: "POST",
      body: JSON.stringify({
        client_id: u.client_id,
        opening_id: op.id,
        ply,
        san,
      }),
    });
    if (r && r.user) _hydrateOpeningFromUser(r.user);
  } catch (_) { /* ignore */ }
  // Local mastery counter.
  const key = `${op.id}:${line.id}`;
  const m = state.opening.mastery[key] || { plays: 0, correct: 0, completed: 0 };
  m.plays += 1;
  if (correct) m.correct += 1;
  if (lineCompleted) m.completed = (m.completed || 0) + 1;
  state.opening.mastery[key] = m;
  _saveOpeningSession();
}

function renderOpeningUi() {
  const card = document.getElementById("opening-card");
  const actions = document.getElementById("opening-actions");
  const stats = document.getElementById("opening-stats-bar");
  const hist = document.getElementById("opening-history");
  if (!card || !actions || !stats) return;
  const op = _selectedOpening();
  const line = _selectedOpeningLine();
  // Stats bar — total plays + completed lines.
  let totalPlays = 0, totalCompleted = 0;
  for (const v of Object.values(state.opening.mastery)) {
    if (v && typeof v === "object") {
      totalPlays += (v.plays || 0);
      totalCompleted += (v.completed || 0);
    }
  }
  stats.innerHTML = `
    <div class="ps-block">
      <span class="ps-label">Дебютов</span>
      <span class="ps-val">${state.opening.catalog.length}</span>
    </div>
    <div class="ps-divider"></div>
    <div class="ps-block">
      <span class="ps-label">Попыток</span>
      <span class="ps-val">${totalPlays}</span>
    </div>
    <div class="ps-divider"></div>
    <div class="ps-block">
      <span class="ps-label">Линий пройдено</span>
      <span class="ps-val ok">${totalCompleted}</span>
    </div>
  `;
  if (!state.opening.catalog.length) {
    card.innerHTML = `<div class="puzzle-empty">Каталог дебютов пуст.</div>`;
    actions.innerHTML = "";
    if (hist) hist.innerHTML = "";
    return;
  }
  // Catalog list.
  const catalog = state.opening.catalog.map((o) => {
    const cls = o.id === state.opening.selectedId ? " is-active" : "";
    const colorTag = o.color === "black" ? "♚" : "♔";
    return `<button type="button" class="opening-cat-item${cls}" data-id="${escapeHtml(o.id)}">
      <span class="opening-color">${colorTag}</span>
      <span class="opening-name">${escapeHtml(o.name)}</span>
      <span class="opening-eco">${escapeHtml(o.eco || "")}</span>
    </button>`;
  }).join("");
  let body = "";
  if (!op) {
    body = `<div class="puzzle-empty">Выбери дебют слева, чтобы начать.</div>`;
  } else {
    const linesHtml = (op.lines || []).map((ln) => {
      const cls = ln.id === (line && line.id) ? " is-active" : "";
      const key = `${op.id}:${ln.id}`;
      const m = state.opening.mastery[key];
      const masteryTxt = m
        ? `<span class="opening-mastery">${m.correct || 0}/${m.plays || 0}${m.completed ? ` · ✓${m.completed}` : ""}</span>`
        : "";
      return `<button type="button" class="opening-line-item${cls}" data-line="${escapeHtml(ln.id)}">
        <span class="opening-line-name">${escapeHtml(ln.name || "Без названия")}</span>
        ${masteryTxt}
      </button>`;
    }).join("");
    const fbCls = state.opening.feedback === "correct" ? "puzzle-banner-ok"
      : state.opening.feedback === "wrong" ? "puzzle-banner-bad"
      : state.opening.feedback === "complete" ? "puzzle-banner-ok" : "";
    const banner = state.opening.coachMsg
      ? `<div class="puzzle-banner ${fbCls}">${escapeHtml(state.opening.coachMsg)}</div>`
      : "";
    const coachPanel = _renderOpeningAiCoachPanel();
    let theory = "";
    if (state.opening.mode === "theory" && line) {
      const sansHtml = (line.moves || []).map((s) => `<span class="opening-san">${escapeHtml(s)}</span>`).join(" ");
      const desc = (line.description || op.description || "");
      theory = `
        <div class="opening-theory">
          <div class="opening-theory-line">${sansHtml}</div>
          ${desc ? `<p class="muted">${escapeHtml(desc)}</p>` : ""}
        </div>
      `;
    } else if (state.opening.mode === "practice" && line) {
      const movesShown = (line.moves || []).slice(0, state.opening.moveIdx)
        .map((s) => `<span class="opening-san">${escapeHtml(s)}</span>`).join(" ");
      theory = `
        <div class="opening-theory">
          <div class="opening-theory-line">${movesShown || `<span class="muted">Сделай первый ход.</span>`}</div>
        </div>
      `;
    }
    body = `
      <div class="opening-meta">
        <h3>${escapeHtml(op.name)}</h3>
        <div class="muted">${escapeHtml(op.eco || "")} · ${op.color === "black" ? "за чёрных" : "за белых"}</div>
      </div>
      <div class="opening-lines">${linesHtml}</div>
      ${theory}
      ${banner}
      ${coachPanel}
    `;
  }
  card.innerHTML = `
    <div class="opening-layout">
      <div class="opening-catalog">${catalog}</div>
      <div class="opening-detail">${body}</div>
    </div>
  `;
  card.querySelectorAll(".opening-cat-item").forEach((b) => {
    b.onclick = () => selectOpening(b.dataset.id);
  });
  card.querySelectorAll(".opening-line-item").forEach((b) => {
    b.onclick = () => selectOpening(state.opening.selectedId, b.dataset.line);
  });
  // Actions.
  if (op && line) {
    const theoryActive  = state.opening.mode === "theory"  ? " is-active" : "";
    const practiceActive = state.opening.mode === "practice" ? " is-active" : "";
    actions.innerHTML = `
      <button id="btn-opening-theory" type="button" class="puzzle-secondary${theoryActive}">Теория</button>
      <button id="btn-opening-practice" type="button" class="puzzle-primary${practiceActive}">Практика</button>
      <button id="btn-opening-reset" type="button" class="puzzle-secondary">Сброс</button>
    `;
    document.getElementById("btn-opening-theory").onclick   = () => setOpeningMode("theory");
    document.getElementById("btn-opening-practice").onclick = () => setOpeningMode("practice");
    document.getElementById("btn-opening-reset").onclick    = () => { state.opening.active = false; _resetOpeningBoard(); renderOpeningUi(); };
  } else {
    actions.innerHTML = "";
  }
  if (hist) hist.innerHTML = "";
  _attachOpeningAiCoachHandlers();
  // Lazily probe Ollama on first render so the panel can show a live status.
  if (state.opening.aiCoach.status === null) {
    _probeOpeningCoach();
  }
}

// ---------- AI coach (Ollama + Stockfish 18) ----------

// Parse the hybrid coach output. The backend now streams a strict
// structured block instead of free-form LLM prose:
//
//   ВЕРДИКТ: <one short line>          ← deterministic, never wrong
//   ТОН: <good|warn|bad|info>          ← drives the headline colour
//   ОЦЕНКА: Stockfish 18, depth N: ±X.XX
//   ЛУЧШИЙ ХОД: <san>                  ← optional
//   <blank line>
//   ИДЕЯ: <one sentence from LLM>
//
// We are *permissive* on stragglers: if a section is missing, we just
// skip it. We are also tolerant of legacy outputs (free-form Russian
// prose) so an old client cache still renders something useful — the
// first non-empty line becomes the headline, the rest is the idea.
function _formatCoachText(raw) {
  const trimmed = (raw || "").trim();
  if (!trimmed) return { headline: "", tone: "", evalText: "", bestSan: "", idea: "" };
  const lines = trimmed.split(/\n/);
  let headline = "";
  let tone = "";
  let evalText = "";
  let bestSan = "";
  let idea = "";
  let sawHeadline = false;
  // We accumulate idea lines (LLM might add a trailing newline) until we
  // hit something non-textual. Anything after the first ИДЕЯ: line is
  // treated as a continuation of the idea sentence.
  let ideaStarted = false;
  const ideaParts = [];
  const stripPrefix = (ln, prefix) => ln.slice(prefix.length).replace(/^[\s::\-—]+/, "").trim();
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const trimmedLn = ln.trim();
    if (ideaStarted) {
      if (trimmedLn) ideaParts.push(trimmedLn);
      continue;
    }
    if (!trimmedLn) continue;
    if (/^ВЕРДИКТ\s*[::\-—]/i.test(trimmedLn)) {
      headline = stripPrefix(trimmedLn, "ВЕРДИКТ");
      sawHeadline = true;
      continue;
    }
    if (/^ТОН\s*[::\-—]/i.test(trimmedLn)) {
      tone = stripPrefix(trimmedLn, "ТОН").toLowerCase();
      continue;
    }
    if (/^ОЦЕНКА\s*[::\-—]/i.test(trimmedLn)) {
      evalText = stripPrefix(trimmedLn, "ОЦЕНКА");
      continue;
    }
    if (/^ЛУЧШИЙ\s+ХОД\s*[::\-—]/i.test(trimmedLn)) {
      bestSan = stripPrefix(trimmedLn, "ЛУЧШИЙ ХОД");
      continue;
    }
    if (/^ИДЕЯ\s*[::\-—]/i.test(trimmedLn)) {
      const after = stripPrefix(trimmedLn, "ИДЕЯ");
      if (after) ideaParts.push(after);
      ideaStarted = true;
      continue;
    }
    // Legacy / free-form fallback: first stray line becomes the headline,
    // rest accumulates as idea so old streams still render.
    if (!sawHeadline) {
      headline = trimmedLn.replace(/^\*+\s*/, "").replace(/\s*\*+$/, "");
      sawHeadline = true;
    } else {
      ideaParts.push(trimmedLn);
    }
  }
  idea = ideaParts.join(" ").trim();
  return { headline, tone, evalText, bestSan, idea };
}

// Map a verdict string to a CSS modifier for colour-coding (good/bad).
// Backend already emits an explicit ТОН line, but we keep this as a
// fallback for legacy outputs and as a sanity check on the explicit
// tone (we trust the backend if it gave us one).
function _verdictTone(headline, explicit) {
  const e = (explicit || "").toLowerCase().trim();
  if (e === "good" || e === "warn" || e === "bad" || e === "info") return e;
  const h = (headline || "").toLowerCase();
  if (!h) return "";
  if (/(грубая ошибка|зевок|зевнул|blunder)/.test(h)) return "bad";
  if (/(не лучший|не теоретический|неточн|inaccur|mistake)/.test(h)) return "warn";
  if (/(точно по теории|по теории|лучший ход|best|brilliant|хороший ход|сильный ход|good|готовимся)/.test(h)) return "good";
  return "";
}

// General opening-trainer tips that aren't tied to any specific line.
// Picked deterministically per opening+line so the same selection
// always shows the same tip — no flicker on re-render.
const OPENING_TIPS = [
  "Дебют — это про развитие фигур и контроль центра. Каждый ход должен помогать одному из этих принципов.",
  "Не делай два хода одной фигурой подряд без причины — это теряет темп.",
  "Рокируй пораньше: безопасность короля важнее симпатичной атаки на королевском фланге.",
  "Не выводи ферзя слишком рано — соперник нападает на него лёгкими фигурами с темпом.",
  "Слон обычно сильнее коня в открытых позициях; конь — в закрытых.",
  "Контроль центральной диагонали и вертикали важнее, чем взятие пешки на краю.",
  "В дебюте каждый ход — это инвестиция: думай не о текущей выгоде, а о позиции через 5 ходов.",
  "Если вышел из теории — продолжай по принципам: развитие, центр, безопасность короля.",
  "Связки и пешечные цепи — основа структуры. Ломая их, ты ломаешь и план соперника.",
  "Не торопись брать центральные пешки — иногда напряжение в центре выгоднее размена.",
  "Запоминай не только ходы, но и идеи: куда пойдут ферзь, ладьи, какую структуру строишь.",
  "Открытая линия — повод поставить туда ладью. Полуоткрытая — повод подумать о давлении.",
  "Слабые поля в лагере соперника — это будущие посадочные площадки для коней.",
  "Делай ход, после которого у соперника становится меньше хороших ответов, а не больше.",
  "В симметричных позициях темп особенно ценен — каждый отыгранный ход меняет оценку.",
  "Чем активнее твои фигуры в дебюте, тем спокойнее эндшпиль.",
];

function _renderOpeningAiCoachPanel() {
  const op = _selectedOpening();
  const line = _selectedOpeningLine();
  if (!op || !line) return "";
  const key = `${op.id}:${line.id}:${state.opening.moveIdx || 0}`;
  const tip = _coachPick(OPENING_TIPS, key);
  // Optional: if the opening has its own description, show it as a
  // muted secondary line under the tip — gives both the dynamic
  // hint and the canonical theory sentence.
  const desc = (line.description || op.description || "").trim();
  return `
    <div class="opening-ai-panel">
      <div class="opening-ai-header">
        <strong>Тренер</strong>
      </div>
      <div class="opening-ai-text">
        <div class="opening-ai-verdict opening-ai-verdict-info">${escapeHtml(tip)}</div>
        ${desc ? `<div class="opening-ai-idea">${escapeHtml(desc)}</div>` : ""}
      </div>
    </div>
  `;
}

// Persisted coach knobs — depth/multipv default to chess.com-ish values
// (depth 18 + 2 PVs) and survive reloads via localStorage.
function _readCoachDepth() {
  const raw = parseInt(localStorage.getItem("chess.coachDepth") || "18", 10);
  if (!Number.isFinite(raw)) return 18;
  return Math.max(6, Math.min(40, raw));
}
function _readCoachMultipv() {
  const raw = parseInt(localStorage.getItem("chess.coachMultipv") || "2", 10);
  if (!Number.isFinite(raw)) return 2;
  return Math.max(1, Math.min(4, raw));
}
function _saveCoachDepthFromInput(el) {
  if (!el) return;
  const v = Math.max(6, Math.min(40, parseInt(el.value, 10) || 18));
  el.value = String(v);
  localStorage.setItem("chess.coachDepth", String(v));
}
function _saveCoachMultipvFromInput(el) {
  if (!el) return;
  const v = Math.max(1, Math.min(4, parseInt(el.value, 10) || 2));
  el.value = String(v);
  localStorage.setItem("chess.coachMultipv", String(v));
}

// All three handlers below used to stream AI coach text from Ollama.
// We dropped the AI integration; these are kept as no-ops so the
// callsites don't have to be rewired (the canned panel above already
// renders without any of this).
function _attachOpeningAiCoachHandlers() { /* no-op since AI coach removed */ }
async function _probeOpeningCoach() { /* no-op since AI coach removed */ }

async function requestOpeningCoach_unused() {
  const op = _selectedOpening();
  const line = _selectedOpeningLine();
  if (!op || !line) {
    return;
  }
  const ai = state.opening.aiCoach;
  if (ai.streaming) return;
  ai.streaming = true;
  ai.text = "";
  ai.error = "";
  // Snapshot what we want to ask about so the request reflects the
  // last meaningful event (correct/wrong move) instead of going stale
  // on the next render.
  const ply = Math.max(0, Math.min(line.moves.length, state.opening.moveIdx));
  const lastSan = ply > 0 ? (line.moves[ply - 1] || "") : "";
  const correct = state.opening.feedback === "correct" || state.opening.feedback === "complete"
    ? true
    : state.opening.feedback === "wrong" ? false : null;
  // When the user just played a *wrong* move, ``state.opening.lastWrongSan``
  // holds the SAN they actually attempted (we snapshotted it in the
  // wrong-move branch before undoing the chess.js move). Sending it to
  // the backend lets it ask Stockfish for the precise cp loss versus
  // the theory move, so the verdict can grade «inaccuracy / mistake /
  // blunder» instead of always saying «не теория».
  const playedSan = correct === false ? (state.opening.lastWrongSan || "") : "";
  ai.lastPly = ply;
  ai.lastSan = lastSan;
  ai.lastCorrect = correct;
  renderOpeningUi();
  try {
    const resp = await fetch(`/api/opening_trainer/coach`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        opening_id: op.id,
        ply,
        last_san: lastSan || null,
        played_san: playedSan || null,
        correct,
        locale: "ru",
        depth: _readCoachDepth(),
        multipv: _readCoachMultipv(),
      }),
    });
    if (!resp.ok || !resp.body) {
      ai.error = `Ошибка тренера: HTTP ${resp.status}`;
      ai.streaming = false;
      renderOpeningUi();
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let pendingRaf = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) {
        ai.text += decoder.decode(value, { stream: true });
        // Throttle re-renders during stream — paint at most every
        // animation frame so we don't spam renderOpeningUi() once per
        // micro-token.
        if (!pendingRaf) {
          pendingRaf = true;
          requestAnimationFrame(() => {
            pendingRaf = false;
            const host = document.querySelector(".opening-ai-text");
            if (host) host.textContent = ai.text;
          });
        }
      }
    }
    // Flush the trailing decoder buffer.
    ai.text += decoder.decode();
    ai.streaming = false;
    renderOpeningUi();
  } catch (e) {
    ai.streaming = false;
    ai.error = `Сеть/тренер: ${(e && e.message) || e}`;
    renderOpeningUi();
  }
}

// ---------- Notifications (SSE) + party invitations ----------

function _bootNotifications() {
  if (!state.user.client_id) return;
  _notificationsConnect();
}

function _notificationsConnect() {
  // Tear down any previous stream.
  if (state.notifications.es) {
    try { state.notifications.es.close(); } catch (_) {}
    state.notifications.es = null;
  }
  if (state.notifications.reconnectTimer) {
    clearTimeout(state.notifications.reconnectTimer);
    state.notifications.reconnectTimer = null;
  }
  const url = `/api/notifications/stream?client_id=${encodeURIComponent(state.user.client_id)}`;
  let es;
  try {
    es = new EventSource(url);
  } catch (_) {
    return;
  }
  state.notifications.es = es;
  es.onmessage = (ev) => {
    let payload;
    try { payload = JSON.parse(ev.data); } catch (_) { return; }
    handleNotificationEvent(payload);
  };
  es.onerror = () => {
    // Browser auto-reconnects on most failures; if it really dies,
    // schedule a manual reopen.
    if (es.readyState === EventSource.CLOSED) {
      state.notifications.reconnectTimer = setTimeout(_notificationsConnect, 4000);
    }
  };
}

function handleNotificationEvent(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "hello":
      // Snapshot of pending invitations on (re)connect.
      (msg.invitations || []).forEach((inv) => _showInvitationToast(inv));
      break;
    case "invitation":
      if (msg.invitation) _showInvitationToast(msg.invitation);
      break;
    case "invitation_accepted":
      if (msg.invitation) {
        _showInfoToast(`✔ ${msg.invitation.host_id === state.user.client_id ? "Друг принял приглашение" : "Принято"}`);
      }
      break;
    case "invitation_declined":
      if (msg.invitation && msg.invitation.host_id === state.user.client_id) {
        _showInfoToast(`Друг отклонил приглашение`);
      }
      break;
  }
}

// Plays a short attention chime so an off-screen invitation doesn't go
// unnoticed. We synthesise a two-note beep through WebAudio so we don't
// need an extra audio asset and so playback is gated by the same user
// gesture that primes our normal move sounds.
function _playInvitationChime() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = _playInvitationChime._ctx
      || (_playInvitationChime._ctx = new Ctx());
    if (ctx.state === "suspended") { try { ctx.resume(); } catch (_) {} }
    const now = ctx.currentTime;
    const playTone = (freq, t0, dur) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, now + t0);
      g.gain.exponentialRampToValueAtTime(0.18, now + t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + t0 + dur);
      o.connect(g).connect(ctx.destination);
      o.start(now + t0);
      o.stop(now + t0 + dur + 0.05);
    };
    playTone(660, 0,    0.22);
    playTone(880, 0.18, 0.28);
  } catch (_) { /* ignore */ }
}

// Browser-level Notification (only fires when the tab is not focused).
// We request permission lazily on the first invitation that arrives
// while the page is hidden so we don't spam the user with a prompt.
function _maybeShowBrowserInviteNotification(inv) {
  if (typeof Notification === "undefined") return;
  if (document.visibilityState !== "hidden" && document.hasFocus()) return;
  const fire = () => {
    try {
      const n = new Notification(`${inv.host_nickname || "Гость"} зовёт в пати`, {
        body: `Код комнаты: ${inv.party_code}`,
        tag: `party-invite-${inv.id}`,
        renotify: true,
        icon: "/static/favicon.ico",
      });
      n.onclick = () => { try { window.focus(); n.close(); } catch (_) {} };
    } catch (_) { /* ignore */ }
  };
  if (Notification.permission === "granted") {
    fire();
  } else if (Notification.permission === "default") {
    Notification.requestPermission().then((perm) => {
      if (perm === "granted") fire();
    }).catch(() => {});
  }
}

function _showInvitationToast(inv) {
  if (!inv || !inv.id) return;
  // Already on screen?
  if (state.notifications.invitations[inv.id]) return;
  state.notifications.invitations[inv.id] = inv;

  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const card = document.createElement("div");
  card.className = "toast";
  card.dataset.invitationId = inv.id;
  card.innerHTML = `
    <div class="toast-header">
      <span class="toast-avatar">${avatarHtml(inv.host_avatar)}</span>
      <div>
        <div class="toast-title">${escapeHtml(inv.host_nickname || "Гость")} зовёт в пати</div>
        <div class="toast-sub">Код комнаты: ${escapeHtml(inv.party_code)}</div>
      </div>
    </div>
    <div class="toast-actions">
      <button type="button" class="toast-btn toast-btn-decline">Отклонить</button>
      <button type="button" class="toast-btn toast-btn-accept">Принять</button>
    </div>
  `;
  card.querySelector(".toast-btn-accept").addEventListener("click", () => {
    _acceptInvitation(inv.id).catch((e) => _showInfoToast(`Ошибка: ${e.message || e}`));
  });
  card.querySelector(".toast-btn-decline").addEventListener("click", () => {
    _declineInvitation(inv.id).catch((e) => _showInfoToast(`Ошибка: ${e.message || e}`));
  });
  stack.appendChild(card);

  // Audible chime — gated by the same sound preference the move sounds use.
  if (userSettings.soundEnabled !== false) _playInvitationChime();
  // Native Notification when the tab isn't focused.
  _maybeShowBrowserInviteNotification(inv);
}

function _dismissInvitationToast(invId) {
  delete state.notifications.invitations[invId];
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const node = stack.querySelector(`[data-invitation-id="${CSS.escape(invId)}"]`);
  if (node) node.remove();
}

function _showInfoToast(text, ttl = 3500) {
  const stack = document.getElementById("toast-stack");
  if (!stack) return;
  const card = document.createElement("div");
  card.className = "toast";
  card.innerHTML = `
    <div class="toast-header">
      <span class="toast-avatar">ℹ</span>
      <div><div class="toast-title">${escapeHtml(text)}</div></div>
    </div>
  `;
  stack.appendChild(card);
  setTimeout(() => card.remove(), ttl);
}

async function _acceptInvitation(invId) {
  const res = await fetch(`/api/party/invitations/${encodeURIComponent(invId)}/accept`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: state.user.client_id }),
  });
  _dismissInvitationToast(invId);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  // Auto-join the party.
  partyConnect(data.code);
  openPartyModal();
}

async function _declineInvitation(invId) {
  await fetch(`/api/party/invitations/${encodeURIComponent(invId)}/decline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: state.user.client_id }),
  }).catch(() => {});
  _dismissInvitationToast(invId);
}

// ---------- Friend picker + open-parties list (party-create modal) ----------

// Renders the lobby's friend invite list: one blue "Пригласить" button
// per registered player, no checkboxes. Each click fires an invite to
// the active room (`partyCode` falls back to `state.party.code`).
async function _renderFriendPicker(partyCode) {
  const host = document.getElementById("party-friend-picker");
  if (!host) return;
  const code = partyCode || state.party.code || "";
  let users = [];
  try {
    const res = await fetch("/api/users");
    const data = await res.json();
    users = (data.users || []).filter((u) => u.client_id !== state.user.client_id);
  } catch (_) {
    host.innerHTML = `<div class="party-friend-empty">Не удалось загрузить список</div>`;
    return;
  }
  if (!users.length) {
    host.innerHTML = `<div class="party-friend-empty">Пока нет других зарегистрированных игроков. Поделись ссылкой на сервер.</div>`;
    return;
  }
  // Show recent / online first.
  users.sort((a, b) => (Number(b.last_seen || 0)) - (Number(a.last_seen || 0)));
  const now = Math.floor(Date.now() / 1000);
  host.innerHTML = users.map((u) => {
    const recent = (now - Number(u.last_seen || 0)) < 300;
    return `
      <div class="party-friend-row" data-cid="${escapeHtml(u.client_id)}">
        <span class="toast-avatar">${avatarHtml(u.avatar)}</span>
        <span class="party-friend-name">${escapeHtml(u.nickname || "Гость")}</span>
        <span class="party-friend-meta">${recent ? "<span class=\"party-friend-online\">● онлайн</span>" : ""} ${Number(u.rating || 1500)} elo</span>
        <button type="button" class="party-friend-invite-btn" data-cid="${escapeHtml(u.client_id)}">Пригласить</button>
      </div>
    `;
  }).join("");
  host.querySelectorAll(".party-friend-invite-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const targetId = btn.dataset.cid;
      if (!targetId || !code) return;
      btn.disabled = true;
      const original = btn.textContent;
      btn.textContent = "Отправляю…";
      try {
        const res = await fetch("/api/party/invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: state.user.client_id,
            target_id: targetId,
            code,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        btn.textContent = "✔ Отправлено";
        btn.classList.add("is-sent");
      } catch (_) {
        btn.textContent = "Ошибка";
        setTimeout(() => {
          btn.textContent = original;
          btn.disabled = false;
        }, 1800);
      }
    });
  });
}

async function _renderOpenPartiesList() {
  const host = document.getElementById("party-open-list");
  if (!host) return;
  let parties = [];
  try {
    const res = await fetch("/api/party/list");
    const data = await res.json();
    parties = (data.parties || []).filter((p) => p.host_id !== state.user.client_id);
  } catch (_) {
    host.innerHTML = `<div class="party-open-empty">Не удалось загрузить</div>`;
    return;
  }
  if (!parties.length) {
    host.innerHTML = `<div class="party-open-empty">Сейчас нет открытых пати</div>`;
    return;
  }
  host.innerHTML = parties.map((p) => {
    const status = p.status === "playing" ? "идёт" : "лобби";
    const cls = p.status === "playing" ? "is-playing" : "";
    const joinable = p.status === "lobby";
    return `
      <div class="party-open-row" data-code="${escapeHtml(p.code)}">
        <span class="toast-avatar">${avatarHtml(p.host_avatar)}</span>
        <div class="party-open-info">
          <div>${escapeHtml(p.host_nickname || "Гость")} · <span class="muted">${escapeHtml(p.code)}</span></div>
          <div class="muted" style="font-size:11px;">${p.members} игроков${p.spectator_count ? ` · ${p.spectator_count} наблюдателей` : ""}</div>
        </div>
        <span class="party-open-status ${cls}">${status}</span>
        <div class="party-open-actions">
          ${joinable ? `<button type="button" class="puzzle-secondary btn-open-join">Войти</button>` : ""}
          ${p.status === "playing" ? `<button type="button" class="puzzle-ghost btn-open-spectate">🔭 Наблюдать</button>` : ""}
        </div>
      </div>
    `;
  }).join("");
  host.querySelectorAll(".party-open-row").forEach((row) => {
    const code = row.dataset.code;
    row.querySelector(".btn-open-join")?.addEventListener("click", () => {
      partyJoin(code).catch((e) => _partyShowError(e));
    });
    row.querySelector(".btn-open-spectate")?.addEventListener("click", () => {
      spectatorConnect(code);
      closePartyModal();
    });
  });
}

// Renders the "Оффлайн" tab — solo puzzle players currently broadcasting.
// Each card is clickable; click attaches a presence-spectator socket
// and surfaces the standard mini-board overlay.
async function _renderPresenceList() {
  const host = document.getElementById("presence-open-list");
  if (!host) return;
  host.innerHTML = `<div class="party-open-empty">Загружаю…</div>`;
  let players = [];
  try {
    const res = await fetch("/api/presence/list");
    const data = await res.json();
    players = (data.players || []).filter(
      (p) => p.client_id !== state.user.client_id,
    );
  } catch (_) {
    host.innerHTML = `<div class="party-open-empty">Не удалось загрузить</div>`;
    return;
  }
  if (!players.length) {
    host.innerHTML = `<div class="party-open-empty">Сейчас никто не решает соло-пазлы</div>`;
    return;
  }
  host.innerHTML = players.map((p) => {
    const rating = p.rating ? `${p.rating}` : "—";
    const puzzleRating = p.puzzle_rating ? `пазл ${p.puzzle_rating}` : "";
    const streak = p.streak ? `🔥 ${p.streak}` : "";
    const meta = [puzzleRating, streak].filter(Boolean).join(" · ");
    return `
      <div class="party-open-row" data-cid="${escapeHtml(p.client_id)}">
        <span class="toast-avatar">${avatarHtml(p.avatar)}</span>
        <div class="party-open-info">
          <div>${escapeHtml(p.nickname || "Гость")} · <span class="muted">${escapeHtml(rating)}</span></div>
          <div class="muted" style="font-size:11px;">${escapeHtml(meta || "решает пазлы")}${p.spectator_count ? ` · ${p.spectator_count} наблюдателей` : ""}</div>
        </div>
        <span class="party-open-status is-playing">соло</span>
        <div class="party-open-actions">
          <button type="button" class="puzzle-ghost btn-presence-spectate">🔭 Наблюдать</button>
        </div>
      </div>
    `;
  }).join("");
  host.querySelectorAll(".party-open-row").forEach((row) => {
    const cid = row.dataset.cid;
    if (!cid) return;
    row.querySelector(".btn-presence-spectate")?.addEventListener("click", () => {
      presenceSpectatorConnect(cid);
      closePartyModal();
    });
  });
}

async function partyCreateAndInvite() {
  // Just create the party — the lobby renders an invite list with
  // per-friend blue "Пригласить" buttons (renderPartyLobby →
  // _renderFriendPicker), so the user picks who to ping after the
  // room exists rather than ahead of time via checkboxes.
  const res = await fetch("/api/party/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: state.user.client_id,
      nickname: state.user.nickname,
      avatar: state.user.avatar,
    }),
  });
  if (!res.ok) throw new Error(`Не удалось создать (HTTP ${res.status})`);
  const data = await res.json();
  partyConnect(data.code);
}

// ---------- Spectator (binoculars) mode ----------

function _spectatorWsUrl(code) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const u = new URL(`${proto}//${location.host}/api/party/ws/${encodeURIComponent(code)}`);
  u.searchParams.set("client_id", state.user.client_id || "");
  u.searchParams.set("nickname", state.user.nickname || "");
  u.searchParams.set("avatar", state.user.avatar || "");
  u.searchParams.set("role", "spectator");
  return u.toString();
}

function spectatorConnect(code) {
  if (state.spectator.ws) {
    try { state.spectator.ws.close(); } catch (_) {}
  }
  state.spectator = {
    active: true,
    ws: null,
    code,
    party_id: null,
    status: "lobby",
    endsAt: 0,
    players: {},
    cursors: {},
    scoreboard: [],
    selectedId: null,
    mode: "single",
  };
  const ws = new WebSocket(_spectatorWsUrl(code));
  state.spectator.ws = ws;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handleSpectatorMessage(msg);
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    state.spectator.active = false;
  };
  _spectatorRender();
}

function handleSpectatorMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "spectator_init": {
      const sp = state.spectator;
      sp.status = msg.status || "lobby";
      sp.endsAt = msg.ends_at || 0;
      sp.party_id = (msg.state || {}).party_id || null;
      sp.scoreboard = msg.scoreboard || [];
      sp.players = {};
      (msg.players || []).forEach((p) => { sp.players[p.client_id] = p; });
      // Pick a default selected player.
      if (!sp.selectedId) {
        const first = (msg.players || [])[0];
        sp.selectedId = first ? first.client_id : null;
      }
      _spectatorRender();
      break;
    }
    case "lobby":
      state.spectator.status = msg.status || state.spectator.status;
      // Reset player set when lobby returns / changes.
      if (Array.isArray(msg.members)) {
        // Make sure every member has a slot in players map.
        msg.members.forEach((m) => {
          if (!state.spectator.players[m.client_id]) {
            state.spectator.players[m.client_id] = {
              client_id: m.client_id,
              nickname: m.nickname,
              avatar: m.avatar,
              score: m.score || 0,
              solved: m.solved || 0,
              fen: "",
            };
          }
        });
      }
      _spectatorRender();
      break;
    case "scoreboard":
      state.spectator.endsAt = msg.ends_at || state.spectator.endsAt;
      state.spectator.scoreboard = msg.scoreboard || state.spectator.scoreboard;
      _spectatorRender();
      break;
    case "start":
    case "match_state":
      state.spectator.status = "playing";
      state.spectator.endsAt = msg.ends_at || state.spectator.endsAt;
      _spectatorRender();
      break;
    case "player_state": {
      const cid = msg.client_id;
      if (!cid) break;
      const prev = state.spectator.players[cid] || {};
      state.spectator.players[cid] = { ...prev, ...msg };
      _spectatorRender();
      break;
    }
    case "player_cursor": {
      const cid = msg.client_id;
      if (!cid) break;
      state.spectator.cursors[cid] = {
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        flipped: !!msg.flipped,
        selected: typeof msg.selected === "string" ? msg.selected : "",
        dragging: !!msg.dragging,
        drag_piece: typeof msg.drag_piece === "string" ? msg.drag_piece : "",
        drag_from: typeof msg.drag_from === "string" ? msg.drag_from : "",
        ts: Date.now(),
      };
      _spectatorRender();
      break;
    }
    case "finish":
      state.spectator.status = "finished";
      state.spectator.scoreboard = msg.results || state.spectator.scoreboard;
      _spectatorRender();
      break;
  }
}

function spectatorLeave() {
  if (state.spectator.ws) {
    try { state.spectator.ws.send(JSON.stringify({ type: "leave" })); } catch (_) {}
    try { state.spectator.ws.close(); } catch (_) {}
  }
  state.spectator.active = false;
  state.spectator.ws = null;
  state.spectator.kind = "party";
  const panel = document.getElementById("spectator-panel");
  if (panel) panel.remove();
}

// Solo-presence spectator. Subscribes to a single live solo player
// and translates `presence_state` / `presence_cursor` / `presence_gone`
// into the same {players[cid], cursors[cid]} shape the party
// spectator renderer already consumes — that way one panel handles
// both modes with no extra UI work.
function presenceSpectatorConnect(targetCid) {
  if (!targetCid) return;
  if (state.spectator.ws) {
    try { state.spectator.ws.close(); } catch (_) {}
  }
  state.spectator = {
    active: true,
    ws: null,
    code: targetCid,
    party_id: null,
    status: "playing",
    endsAt: 0,
    players: {},
    cursors: {},
    scoreboard: [],
    selectedId: targetCid,
    mode: "single",
    kind: "presence",
  };
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const u = new URL(`${proto}//${location.host}/api/presence/ws`);
  u.searchParams.set("client_id", state.user.client_id || `s-${Math.random().toString(36).slice(2, 10)}`);
  u.searchParams.set("nickname", state.user.nickname || "");
  u.searchParams.set("avatar", state.user.avatar || "");
  u.searchParams.set("role", "spectator");
  u.searchParams.set("watch", targetCid);
  let ws;
  try { ws = new WebSocket(u.toString()); }
  catch (_) {
    state.spectator.active = false;
    return;
  }
  state.spectator.ws = ws;
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    handlePresenceSpectatorMessage(msg);
  };
  ws.onerror = () => { /* surface as close */ };
  ws.onclose = () => {
    if (state.spectator.kind === "presence") {
      state.spectator.active = false;
      state.spectator.ws = null;
    }
  };
  _spectatorRender();
}

// Translates the presence WS payloads into the shape the existing
// spectator renderer expects. ``presence_state`` carries everything
// (FEN, theme, pieces, selection, last_move, flipped) so we just
// merge it into players[cid]; ``presence_cursor`` mirrors the
// `player_cursor` shape one-to-one.
function handlePresenceSpectatorMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  switch (msg.type) {
    case "presence_state": {
      const cid = msg.client_id;
      if (!cid) break;
      const sp = state.spectator;
      const prev = sp.players[cid] || {};
      sp.players[cid] = {
        ...prev,
        client_id: cid,
        nickname: msg.nickname || prev.nickname || "",
        avatar: msg.avatar || prev.avatar || "♟",
        theme: typeof msg.theme === "string" ? msg.theme : (prev.theme || ""),
        pieces: typeof msg.pieces === "string" ? msg.pieces : (prev.pieces || ""),
        legal_color: typeof msg.legal_color === "string" ? msg.legal_color : (prev.legal_color || ""),
        rating: Number(msg.rating || prev.rating || 0),
        flipped: !!msg.flipped,
        last_move: typeof msg.last_move === "string" ? msg.last_move : "",
        selection: msg.selection || null,
        fen: typeof msg.fen === "string" ? msg.fen : (prev.fen || ""),
        puzzle_id: msg.puzzle_id || prev.puzzle_id || "",
        puzzle_rating: Number(msg.puzzle_rating || prev.puzzle_rating || 0),
        streak: Number(msg.streak || 0),
        best_streak: Number(msg.best_streak || 0),
        score: Number(msg.streak || 0),
        solved: Number(msg.best_streak || 0),
      };
      sp.selectedId = cid;
      _spectatorRender();
      break;
    }
    case "presence_cursor": {
      const cid = msg.client_id;
      if (!cid) break;
      state.spectator.cursors[cid] = {
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        flipped: !!msg.flipped,
        selected: typeof msg.selected === "string" ? msg.selected : "",
        dragging: !!msg.dragging,
        drag_piece: typeof msg.drag_piece === "string" ? msg.drag_piece : "",
        drag_from: typeof msg.drag_from === "string" ? msg.drag_from : "",
        ts: Date.now(),
      };
      _spectatorRender();
      break;
    }
    case "presence_gone": {
      const cid = msg.client_id;
      if (!cid) break;
      const sp = state.spectator;
      delete sp.players[cid];
      delete sp.cursors[cid];
      sp.status = "finished";
      _spectatorRender();
      break;
    }
  }
}

function _spectatorRender() {
  let panel = document.getElementById("spectator-panel");
  if (!state.spectator.active) {
    if (panel) panel.remove();
    return;
  }
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "spectator-panel";
    panel.className = "spectator-panel";
    document.body.appendChild(panel);
  }
  const sp = state.spectator;
  const players = Object.values(sp.players);
  // Pull live scores from scoreboard if present.
  const sbMap = {};
  (sp.scoreboard || []).forEach((r) => { sbMap[r.client_id] = r; });
  players.forEach((p) => {
    const r = sbMap[p.client_id];
    if (r) {
      p.score = r.score;
      p.solved = r.solved;
      p.failed = r.failed;
      p.skipped = r.skipped;
    }
  });
  // Sort by current score desc.
  players.sort((a, b) => (b.score || 0) - (a.score || 0));
  if (!sp.selectedId && players.length) sp.selectedId = players[0].client_id;
  const selected = sp.players[sp.selectedId] || players[0] || null;

  const timer = sp.status === "playing"
    ? _formatPartyTimeLeft(sp.endsAt)
    : (sp.status === "finished" ? "Финиш" : "Лобби");

  const isPresence = sp.kind === "presence";
  // Presence-mode follows exactly one player, so the grid toggle and
  // timer make no sense — collapse the header to "watching X".
  const headerMeta = isPresence
    ? `<span class="spectator-meta">соло</span>`
    : `<span class="spectator-meta">${escapeHtml(sp.code || "")} · ${escapeHtml(timer)}</span>`;
  const headerToggles = isPresence
    ? ""
    : `
      <button type="button" class="spectator-toggle ${sp.mode === "single" ? "is-active" : ""}" data-mode="single">Одна доска</button>
      <button type="button" class="spectator-toggle ${sp.mode === "grid" ? "is-active" : ""}" data-mode="grid">Все доски</button>
    `;
  panel.innerHTML = `
    <div class="spectator-header">
      <span class="spectator-title">🔭 Наблюдатель</span>
      ${headerMeta}
      <span class="spectator-spacer"></span>
      ${headerToggles}
      <button type="button" class="spectator-leave">Выйти</button>
    </div>
    <div class="spectator-body">
      <aside class="spectator-side">
        <h3>Игроки</h3>
        ${players.map((p) => `
          <div class="spectator-player-row ${p.client_id === sp.selectedId ? "is-selected" : ""}" data-cid="${escapeHtml(p.client_id)}">
            <span class="toast-avatar">${avatarHtml(p.avatar)}</span>
            <span class="pname">${escapeHtml(p.nickname || "Гость")}</span>
            <span class="pscore">${Number(p.score || 0)}</span>
          </div>
        `).join("") || `<div class="muted" style="padding: 8px;">Никого…</div>`}
      </aside>
      <div class="spectator-stage">
        ${sp.mode === "single"
          ? _spectatorRenderSingle(selected)
          : _spectatorRenderGrid(players)}
      </div>
    </div>
  `;
  panel.querySelectorAll(".spectator-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      sp.mode = btn.dataset.mode || "single";
      _spectatorRender();
    });
  });
  panel.querySelector(".spectator-leave").addEventListener("click", spectatorLeave);
  panel.querySelectorAll(".spectator-player-row").forEach((row) => {
    row.addEventListener("click", () => {
      sp.selectedId = row.dataset.cid;
      sp.mode = "single";
      _spectatorRender();
    });
  });
}

function _spectatorRenderSingle(p) {
  if (!p) return `<div class="muted">Игрок не выбран</div>`;
  const fen = p.fen || "";
  const streak = Number(p.streak || 0);
  const streakHtml = streak >= 3
    ? `<span class="ps-val ok">🔥 ${streak}</span>`
    : `<span class="ps-val">🔥 ${streak}</span>`;
  // Solo-presence view shows real-rating + current puzzle rating;
  // party view keeps the score / solved / failed breakdown.
  const isPresence = state.spectator && state.spectator.kind === "presence";
  const metaInner = isPresence
    ? `
        <h3>${escapeHtml(p.nickname || "Гость")} ${avatarHtml(p.avatar, { fallback: "" })}</h3>
        <div class="row">Рейтинг игрока: <b>${Number(p.rating || 0) || "—"}</b></div>
        <div class="row">Текущий пазл: ${p.puzzle_rating ? `<b>${Number(p.puzzle_rating)}</b>` : "—"}</div>
        <div class="row">Серия: ${streakHtml}${p.best_streak ? ` · макс ${Number(p.best_streak || 0)}` : ""}</div>
      `
    : `
        <h3>${escapeHtml(p.nickname || "Гость")} ${avatarHtml(p.avatar, { fallback: "" })}</h3>
        <div class="row">Очки: <b>${Number(p.score || 0)}</b></div>
        <div class="row">Решено: ${Number(p.solved || 0)} · ошибок: ${Number(p.failed || 0)} · пропущено: ${Number(p.skipped || 0)}</div>
        <div class="row">Серия: ${streakHtml}${p.best_streak ? ` · макс ${Number(p.best_streak || 0)}` : ""}</div>
      `;
  return `
    <div class="spectator-single">
      <div class="board-host">${_renderMiniBoardFromFen(fen, p)}</div>
      <div class="meta-host">${metaInner}</div>
    </div>
  `;
}

function _spectatorRenderGrid(players) {
  if (!players.length) return `<div class="muted">Никого нет</div>`;
  return `
    <div class="spectator-grid">
      ${players.map((p) => {
        const streak = Number(p.streak || 0);
        return `
          <div class="grid-cell" data-cid="${escapeHtml(p.client_id)}">
            <div class="grid-head">
              <span>${avatarHtml(p.avatar)}</span>
              <span class="gname">${escapeHtml(p.nickname || "Гость")}</span>
              <span class="gscore">${Number(p.score || 0)}</span>
            </div>
            <div class="grid-streak">Серия: 🔥 ${streak}</div>
            <div class="board-host">${_renderMiniBoardFromFen(p.fen || "", p)}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

function _miniBoardThemeStyle(themeKey) {
  const t = BOARD_THEMES[themeKey] || BOARD_THEMES[DEFAULT_BOARD_THEME];
  if (!t) return "";
  // Scope the theme variables to this wrapper only — spectators
  // viewing player A and player B at the same time may see two
  // different themes side by side, so we cannot mutate :root.
  const lightSq = t.image ? "transparent" : t.light;
  const darkSq = t.image ? "transparent" : t.dark;
  // Inline style attributes are quoted with `"` in our HTML strings,
  // so the URL must NOT contain a literal `"` (it would terminate
  // the attribute and the whole rule would be silently dropped —
  // which is what was killing the board background for image-based
  // themes in the spectator). CSS allows unquoted url(...) for paths
  // without parentheses or whitespace; our static asset paths are
  // safe so we emit them bare.
  const boardImage = t.image ? `url(${t.image})` : "none";
  const cls = t.image ? "mini-board-wrap board-theme-image" : "mini-board-wrap";
  return {
    cls,
    style: (
      `--light-sq:${lightSq};--dark-sq:${darkSq};--board-image:${boardImage};`
    ),
  };
}

// FEN -> read-only mini-board rendered in the *watched* player's
// chosen piece set and board theme (so the spectator always sees the
// same board the player is looking at, regardless of the spectator's
// own settings). Mirrors the main board's a-h/1-8 strip labels.
function _renderMiniBoardFromFen(fen, player) {
  const pieceSet = (player && player.pieces) || getPieceSet();
  const themeKey = (player && player.theme) || userSettings.theme;
  const themeStyle = _miniBoardThemeStyle(themeKey);
  const cid = (player && player.client_id) || "";
  // Mirror the player's own orientation so the watcher sees the exact
  // same board the player is staring at. Without this, a player
  // solving for black would have their board flipped while spectators
  // would still see white-on-bottom — left/right and top/bottom
  // would be inverted between them.
  const flipped = !!(player && player.flipped);
  // Player's chosen "legal hint" colour drives the dot / capture-ring
  // overlay so the watcher sees hints in the same colour the player
  // configured. CSS reads --mb-legal-dot for fills.
  const legalColor = (player && typeof player.legal_color === "string"
    && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(player.legal_color))
    ? player.legal_color
    : "#28c85a";
  const legalRgba = _hexToRgba(legalColor, 0.55);
  // Cursor / selection overlay sourced from `player_state` cursor
  // updates relayed by the server. The player normalizes their
  // cursor to white-on-bottom coords before sending; if the spectator
  // is rendering flipped we re-mirror so the dot lands on the same
  // visual square the player is hovering.
  const cursor = (player && state.spectator && state.spectator.cursors)
    ? state.spectator.cursors[cid]
    : null;
  let overlayHtml = "";
  if (cursor && typeof cursor.x === "number" && typeof cursor.y === "number") {
    const cx = flipped ? 1 - cursor.x : cursor.x;
    const cy = flipped ? 1 - cursor.y : cursor.y;
    const x = Math.max(0, Math.min(1, cx)) * 100;
    const y = Math.max(0, Math.min(1, cy)) * 100;
    // Floating dragged-piece glyph: rendered first so the cursor dot
    // sits on top of it (player's chosen piece set, sized like a
    // mini-board cell so it visually matches the squares).
    if (cursor.dragging && cursor.drag_piece) {
      const dp = String(cursor.drag_piece);
      // dp like "wQ" / "bP" — convert to FEN char so pieceSvgUrl
      // resolves the right asset under the player's piece set.
      const color = dp[0];
      const t = (dp[1] || "P").toUpperCase();
      const fenChar = color === "w" ? t : t.toLowerCase();
      const url = pieceSvgUrl(fenChar, pieceSet);
      overlayHtml += `<img class="mb-drag-piece" src="${url}" alt="${escapeHtml(dp)}" draggable="false" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;">`;
    }
    const cls = cursor.dragging ? "mb-cursor is-drag" : "mb-cursor";
    overlayHtml += `<div class="${cls}" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;"></div>`;
  }
  // Helper: convert algebraic ("e4") to row/col indices in the
  // currently rendered orientation. Pure white-on-bottom: file 'a'
  // is column 0, rank 8 is row 0. Flipped: invert both.
  const sqToRC = (sq) => {
    if (!sq || sq.length !== 2) return null;
    const file = sq.charCodeAt(0) - "a".charCodeAt(0);
    const rank = parseInt(sq[1], 10);
    if (file < 0 || file > 7 || rank < 1 || rank > 8) return null;
    const r = flipped ? rank - 1 : 8 - rank;
    const f = flipped ? 7 - file : file;
    return { r, f };
  };
  if (!fen || typeof fen !== "string") {
    return `<div class="${themeStyle.cls}" style="${themeStyle.style}">
      <div class="mb-ranks"></div>
      <div class="mini-board" data-cid="${escapeHtml(cid)}">${overlayHtml}</div>
      <div class="mb-corner"></div>
      <div class="mb-files"></div>
    </div>`;
  }
  const rawRows = fen.split(" ")[0].split("/");
  if (rawRows.length !== 8) return `<div class="${themeStyle.cls}" style="${themeStyle.style}"></div>`;
  const selectedRC = (cursor && cursor.selected) ? sqToRC(cursor.selected) : null;
  // Last applied move (e.g. "e2e4") sent in `player_state`.
  const lm = (player && typeof player.last_move === "string") ? player.last_move : "";
  const lmFromRC = lm.length >= 4 ? sqToRC(lm.slice(0, 2)) : null;
  const lmToRC = lm.length >= 4 ? sqToRC(lm.slice(2, 4)) : null;
  // Player's current selection — `from` square + the squares they can
  // legally move to (split into plain moves vs captures so we render
  // dot vs ring like the main board does).
  const selection = (player && player.selection) || null;
  const selFromRC = (selection && selection.from) ? sqToRC(selection.from) : null;
  const moveSet = new Set();
  const captureSet = new Set();
  if (selection) {
    (selection.legal_moves || []).forEach((sq) => moveSet.add(sq));
    (selection.legal_captures || []).forEach((sq) => captureSet.add(sq));
    // A square in both lists is a capture — drop from the moves set.
    captureSet.forEach((sq) => moveSet.delete(sq));
  }
  const cells = [];
  for (let r = 0; r < 8; r++) {
    // Source row in the FEN — flipped boards walk the FEN bottom-up.
    const fenRowIdx = flipped ? 7 - r : r;
    const row = rawRows[fenRowIdx];
    const expanded = [];
    for (const ch of row) {
      if (/\d/.test(ch)) {
        for (let i = 0; i < Number(ch); i++) expanded.push("");
      } else {
        expanded.push(ch);
      }
    }
    if (expanded.length !== 8) {
      return `<div class="${themeStyle.cls}" style="${themeStyle.style}"></div>`;
    }
    for (let f = 0; f < 8; f++) {
      const fenColIdx = flipped ? 7 - f : f;
      const isLight = (fenRowIdx + fenColIdx) % 2 === 0;
      const piece = expanded[fenColIdx];
      const pieceHtml = piece
        ? `<img class="mb-piece" src="${pieceSvgUrl(piece, pieceSet)}" alt="${piece}" draggable="false">`
        : "";
      const isSelected = selectedRC && selectedRC.r === r && selectedRC.f === f;
      const isLm = (lmFromRC && lmFromRC.r === r && lmFromRC.f === f)
        || (lmToRC && lmToRC.r === r && lmToRC.f === f);
      // Squares the watched player can legally land on.
      const fileChar = String.fromCharCode("a".charCodeAt(0) + (flipped ? 7 - f : f));
      const rankChar = String(flipped ? r + 1 : 8 - r);
      const sqName = fileChar + rankChar;
      const isFromSel = selFromRC && selFromRC.r === r && selFromRC.f === f;
      const isMove = moveSet.has(sqName);
      const isCapture = captureSet.has(sqName);
      // Hint overlay rendered as a child element (the square's own
      // ::before/::after slots are already taken by last-move /
      // selected highlights).
      const hintHtml = isCapture
        ? `<span class="mb-hint mb-hint-capture"></span>`
        : isMove
          ? `<span class="mb-hint mb-hint-move"></span>`
          : "";
      const extra =
        `${isSelected ? " mb-selected" : ""}` +
        `${isLm ? " mb-lastmove" : ""}` +
        `${isFromSel ? " mb-sel-from" : ""}`;
      const cls = `mb-square ${isLight ? "mb-light" : "mb-dark"}${extra}`;
      cells.push(`<div class="${cls}">${pieceHtml}${hintHtml}</div>`);
    }
  }
  const rankOrder = flipped
    ? ["1", "2", "3", "4", "5", "6", "7", "8"]
    : ["8", "7", "6", "5", "4", "3", "2", "1"];
  const fileOrder = flipped
    ? ["h", "g", "f", "e", "d", "c", "b", "a"]
    : ["a", "b", "c", "d", "e", "f", "g", "h"];
  const ranks = rankOrder.map((r) => `<span>${r}</span>`).join("");
  const files = fileOrder.map((f) => `<span>${f}</span>`).join("");
  // Append the player's legal-hint colour as a CSS variable so the
  // mini-board's dot/ring overlays render in their colour, not the
  // spectator's default.
  const wrapStyle = `${themeStyle.style}--mb-legal-dot:${legalRgba};--mb-legal-color:${legalColor};`;
  return `
    <div class="${themeStyle.cls}" style="${wrapStyle}">
      <div class="mb-ranks">${ranks}</div>
      <div class="mini-board" data-cid="${escapeHtml(cid)}">${cells.join("")}${overlayHtml}</div>
      <div class="mb-corner"></div>
      <div class="mb-files">${files}</div>
    </div>
  `;
}

// ---------- Boot ----------

loadFen(STARTPOS_FEN);
renderPalette();
renderBoard();
setBoardMode(true);
refreshEngineStatus();
_bootUser();

// Expose for debugging.
window.__chess = { state, buildFen, loadFen };
