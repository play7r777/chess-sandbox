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
};

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
function loadSettings() {
  const fallback = {
    theme: DEFAULT_BOARD_THEME,
    pieces: DEFAULT_PIECE_SET,
    soundOn: true,
    pvArrowCount: DEFAULT_PV_ARROW_COUNT,
    bestLineLength: DEFAULT_BEST_LINE_LENGTH,
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
}
applyBoardTheme();

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

function pieceSvgUrl(piece) {
  const color = piece === piece.toUpperCase() ? "w" : "b";
  return `/static/pieces/${getPieceSet()}/${color}${piece.toUpperCase()}.${getPieceExt()}`;
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

const PIECE_TYPES_WHITE = ["K", "Q", "R", "B", "N", "P"];
const PIECE_TYPES_BLACK = ["k", "q", "r", "b", "n", "p"];
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const STARTPOS_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const EMPTY_FEN = "8/8/8/8/8/8/8/8 w - - 0 1";

const state = {
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
// per-side order ("white's 1st move", "white's 2nd", etc.).
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

  // Side-of-move palette. White arrows are off-white with a thin dark
  // outline so they stay visible on light squares; black arrows are
  // a deep slate with a thin light outline.
  const PALETTE = {
    w: { fill: "245, 245, 245", outline: "rgba(15, 18, 25, 0.55)" },
    b: { fill: "30, 32, 38",    outline: "rgba(255, 255, 255, 0.45)" },
  };

  // Side-to-move at the position currently displayed. PV[0] is played
  // by this side; the colour of arrow `i` is decided by `(stm + i) % 2`.
  const stm = state.sideToMove === "b" ? "b" : "w";
  const count = _clampArrows(userSettings.pvArrowCount);
  const maxPlies = count * 2;

  // Build [ply][side] -> alpha lookup. Arrow alpha fades linearly
  // within each side from 0.92 down to 0.30 across `count` arrows.
  function alphaFor(orderInSide) {
    const t = (orderInSide - 1) / Math.max(1, count - 1);
    return Math.max(0.22, 0.92 - 0.62 * t);
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

  function drawArrow(fromSq, toSq, side, orderInSide, totalIdx) {
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
    tx.textContent = String(orderInSide);
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
      drawArrow(fromSq, toSq, side, orderInSide, i);
    }
  } else if (hasBest) {
    // No PV data (e.g. drill-mode hint): single arrow coloured by stm.
    drawArrow(state.bestArrow.from, state.bestArrow.to, stm, 1, 0);
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
  // Drill mode hijacks freeplay drops: instead of mutating the
  // sandbox we treat the drop as the user's "answer" to the puzzle.
  if (state.drill.active) {
    tryDrillMove(from, to);
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
  for (const sq of r.targets) {
    const cell = boardEl.querySelector(`.square[data-square="${sq}"]`);
    if (!cell) continue;
    const piece = r.chess.get(sq);
    cell.classList.add(piece ? "legal-capture" : "legal-move");
    _dragHighlightedSquares.add(sq);
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
  const v = view === "analysis" ? "analysis" : "main";
  document.body.classList.toggle("view-main",     v === "main");
  document.body.classList.toggle("view-analysis", v === "analysis");
  document.querySelectorAll(".view-tab").forEach((btn) => {
    const isActive = btn.dataset.view === v;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  try { localStorage.setItem("cs.view", v); } catch (_) { /* ignore */ }
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
};

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
    document.getElementById("review-progress").textContent =
      `${r.headers.White || "?"} vs ${r.headers.Black || "?"} — ${r.moves_uci.length} полуходов. Жми «Анализировать».`;
    document.getElementById("btn-review-analyse").disabled = false;
    renderPlayerStrips();
    renderReviewMoves();
    document.getElementById("review-summary").innerHTML = "";
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
    const isActive = review.filter.has(k);
    const isOff = n === 0;
    const color = REVIEW_COLOR[k];
    return `<div class="gr-row gr-row-cls cls-${k}${isOff ? " is-off" : ""}${isActive ? " is-active" : ""}" data-cls="${k}" style="--cls-color:${color}">
      <div class="gr-cell gr-label">${REVIEW_LABELS[k]}</div>
      <div class="gr-cell gr-side-w gr-count" style="color:${color}">${nW}</div>
      <div class="gr-cell gr-icon">${REVIEW_BADGE_SVG[k] || ""}</div>
      <div class="gr-cell gr-side-b gr-count" style="color:${color}">${nB}</div>
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

  // Wire row click → filter toggle.
  root.querySelectorAll(".gr-row-cls").forEach((row) => {
    if (row.classList.contains("is-off")) return;
    row.addEventListener("click", () => {
      const k = row.dataset.cls;
      if (review.filter.has(k)) review.filter.delete(k);
      else review.filter.add(k);
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
  // White at bottom, black at top: when frac is large (white winning),
  // white block grows.
  const flipped = state.flipped;
  const whiteBottom = !flipped;
  // CSS variables drive the flex-basis percentages.
  if (whiteBottom) {
    bar.style.setProperty("--eval-white", `${(frac * 100).toFixed(2)}%`);
    bar.style.setProperty("--eval-black", `${((1 - frac) * 100).toFixed(2)}%`);
  } else {
    bar.style.setProperty("--eval-white", `${((1 - frac) * 100).toFixed(2)}%`);
    bar.style.setProperty("--eval-black", `${(frac * 100).toFixed(2)}%`);
  }
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
  state.drill.active = true;
  state.drill.moments = filtered;
  state.drill.idx = 0;
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
    playMoveSoundFor(move, { isOwn: true, inCheck: c.isCheck() });
    setTimeout(nextDrill, 1400);
  } else {
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
  }
}

function nextDrill() {
  if (!state.drill.active) return;
  if (state.drill.idx + 1 >= state.drill.moments.length) {
    exitDrill(true);
    return;
  }
  state.drill.idx += 1;
  loadDrillMoment();
}

function exitDrill(finished) {
  const wasActive = state.drill.active;
  state.drill.active = false;
  state.drill.moments = [];
  state.drill.expectedUci = null;
  state.drill.expectedSan = null;
  state.drill.feedback = null;
  renderDrillUi();
  if (!wasActive) return;
  if (finished) {
    setStatus("Тренировка завершена — все ключевые моменты пройдены.", "info");
  }
  // Restore review view if there was one.
  if (review.activeIdx >= 0) jumpToReviewIdx(review.activeIdx);
}

function renderDrillUi() {
  const host = document.getElementById("drill-panel");
  if (!host) return;
  if (!state.drill.active) {
    host.innerHTML = "";
    host.style.display = "none";
    return;
  }
  host.style.display = "block";
  const total = state.drill.moments.length;
  const cur = state.drill.idx + 1;
  const sideLabel = state.drill.side === "w" ? "Белые" : "Чёрные";
  let feedback = "";
  if (state.drill.feedback === "correct") {
    feedback = `<div class="drill-msg drill-ok">✓ Верно! Лучший ход — <b>${escapeHtml(state.drill.expectedSan)}</b></div>`;
  } else if (state.drill.feedback === "wrong") {
    feedback = `<div class="drill-msg drill-bad">✕ Не лучший ход. Попробуй ещё раз или нажми «Подсказка».</div>`;
  }
  host.innerHTML = `
    <div class="drill-head">
      <span class="drill-title">🎯 Тренировка ключевых моментов · ${cur} / ${total}</span>
      <button id="drill-exit" type="button" class="drill-secondary">✕ Выйти</button>
    </div>
    <div class="drill-prompt">Ход за <b>${sideLabel}</b>. Найди лучший ход.</div>
    ${feedback}
    <div class="drill-actions">
      <button id="drill-hint" type="button" class="drill-secondary">💡 Подсказка</button>
      <button id="drill-show" type="button" class="drill-secondary">👁 Показать ответ</button>
      <button id="drill-skip" type="button" class="drill-secondary">⤳ Пропустить</button>
    </div>
  `;
  const exitBtn = document.getElementById("drill-exit");
  if (exitBtn) exitBtn.onclick = () => exitDrill(false);
  const hintBtn = document.getElementById("drill-hint");
  if (hintBtn) hintBtn.onclick = () => {
    const u = state.drill.expectedUci;
    if (u && u.length >= 4) {
      // Highlight the source square only (small hint, not the full arrow).
      state.bestArrow = { from: u.slice(0, 2), to: u.slice(0, 2) };
      renderBoard();
    }
  };
  const showBtn = document.getElementById("drill-show");
  if (showBtn) showBtn.onclick = () => {
    const u = state.drill.expectedUci;
    if (u && u.length >= 4) {
      state.bestArrow = { from: u.slice(0, 2), to: u.slice(2, 4) };
      renderBoard();
    }
  };
  const skipBtn = document.getElementById("drill-skip");
  if (skipBtn) skipBtn.onclick = nextDrill;
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
    if (review.filter.size > 0 && !review.filter.has(m.classification)) {
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
  const coachLine = (m.coach && m.coach.length)
    ? `<div class="coach-line">💡 ${m.coach.map(escapeHtml).join(" · ")}</div>` : "";
  // Show the engine's PV line (first ≤5 SAN moves) when we didn't play
  // the top move — gives the user a glimpse of "what was right and why".
  let pvLine = "";
  if (
    m.best_pv_san
    && m.best_pv_san.length >= 2
    && m.move_uci !== m.best_move_uci
  ) {
    const lineLen = _clampBestLine(userSettings.bestLineLength);
    const sansHtml = m.best_pv_san.slice(0, lineLen)
      .map((s) => `<span class="pv-san">${escapeHtml(s)}</span>`).join("");
    pvLine = `<div class="pv-line"><span class="pv-label">Лучшая линия:</span>${sansHtml}</div>`;
  }
  host.innerHTML = main + coachLine + pvLine;
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

// ---------- Boot ----------

loadFen(STARTPOS_FEN);
renderPalette();
renderBoard();
setBoardMode(true);
refreshEngineStatus();

// Expose for debugging.
window.__chess = { state, buildFen, loadFen };
