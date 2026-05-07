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
  user: { client_id: null, nickname: "", avatar: "♟", elo_history: null },
  // Active party / co-op puzzle session, if any.
  party: {
    active: false,       // true between WS open and "finish" message
    ws: null,
    code: null,
    party_id: null,
    host_id: null,
    status: "lobby",     // lobby | playing | finished
    endsAt: 0,
    members: [],
    scoreboard: [],
    finalResults: null,
    selfScore: 0,
    countdownInterval: null,
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
    scoreboard: [],
    selectedId: null,
    mode: "single",     // single | grid
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
  let v;
  if (view === "analysis")    v = "analysis";
  else if (view === "puzzle") v = "puzzle";
  else                        v = "main";
  const prev = state.view;
  state.view = v;
  document.body.classList.toggle("view-main",     v === "main");
  document.body.classList.toggle("view-analysis", v === "analysis");
  document.body.classList.toggle("view-puzzle",   v === "puzzle");
  document.querySelectorAll(".view-tab").forEach((btn) => {
    const isActive = btn.dataset.view === v;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", isActive ? "true" : "false");
  });
  try { localStorage.setItem("cs.view", v); } catch (_) { /* ignore */ }
  // Puzzle mode owns the board while it's the active view; entering
  // and leaving the view is the natural place to load a puzzle / put
  // the board back the way the user found it.
  if (v === "puzzle") {
    enterPuzzleView();
  } else if (prev === "puzzle" && state.puzzle && state.puzzle.current) {
    leavePuzzleView();
  }
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
  // Auto-load a puzzle when entering an empty view.
  if (!state.puzzle.current) {
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
  // Action buttons depend on whether we're solving or finished.
  const finished = !state.puzzle.active;
  if (finished) {
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
    });
  });
}

function showOnboarding() {
  const modal = document.getElementById("onboarding-modal");
  if (!modal) return;
  const nickInput = document.getElementById("onboarding-nick");
  if (nickInput) nickInput.value = state.user.nickname || "";
  _renderOnboardingAvatars(state.user.avatar || "♟");
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

document.getElementById("btn-onboarding-save")?.addEventListener("click", async () => {
  const nickInput = document.getElementById("onboarding-nick");
  const nickname = (nickInput?.value || "").trim().slice(0, 32) || "Гость";
  const avatar = _selectedOnboardingAvatar();
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
    } else if (action === "party") {
      openPartyModal();
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
    <svg class="elo-graph" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      ${tickLines.join("")}
      <path d="${fillPath}" fill="url(#elo-grad)" opacity="0.3" />
      <path d="${path}" fill="none" stroke="#6da7ff" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
      <defs>
        <linearGradient id="elo-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="#6da7ff" stop-opacity="0.6" />
          <stop offset="100%" stop-color="#6da7ff" stop-opacity="0" />
        </linearGradient>
      </defs>
    </svg>
  `;
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
  state.user.elo_history = clientId === state.user.client_id ? user.elo_history : null;
  const stats = user.stats || {};
  const games = stats.games || 0;
  const solved = stats.solved || 0;
  const wrong = stats.wrong || 0;
  const skipped = stats.skipped || 0;
  const winPct = games ? (solved / games * 100).toFixed(1) : "0";
  const isSelf = user.client_id === state.user.client_id;
  body.innerHTML = `
    <header class="profile-header">
      <div class="profile-avatar">${escapeHtml(user.avatar || "♟")}</div>
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
      <div>${user.parties.slice(-10).reverse().map((p) => `
        <div class="profile-stat" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
          <span><b>#${p.placement}</b> из ${p.participants}</span>
          <span class="muted">${p.solved} решено · ${p.elo_gained >= 0 ? "+" : ""}${p.elo_gained} эло</span>
        </div>
      `).join("")}</div>
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
          <span class="lb-avatar">${escapeHtml(u.avatar || "♟")}</span>
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
  return u.toString();
}

function _partyEnsureModal() {
  const m = document.getElementById("party-modal");
  if (m) m.hidden = false;
  return document.getElementById("party-body");
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
  const body = _partyEnsureModal();
  if (!body) return;
  if (state.party.active && state.party.status === "playing") {
    closePartyModal();
    return;
  }
  body.innerHTML = `
    <header class="party-header">
      <h2>🎉 Party</h2>
      <p class="muted">Каждому участнику даётся 10 минут на свой поток пазлов; в конце — общий лидерборд.</p>
    </header>

    <div class="party-section-title">Открытые пати</div>
    <div id="party-open-list" class="party-open-list">
      <div class="party-open-empty">Загружаю…</div>
    </div>

    <div class="party-section-title">Пригласить друзей</div>
    <div id="party-friend-picker" class="party-friends">
      <div class="party-friend-empty">Загружаю список игроков…</div>
    </div>
    <div class="party-actions">
      <button id="btn-party-create" type="button" class="puzzle-primary">Создать комнату и пригласить</button>
      <button id="btn-party-create-empty" type="button" class="puzzle-secondary">Создать пустую (без приглашений)</button>
    </div>

    <details class="party-fallback" style="margin-top: 14px;">
      <summary class="muted" style="cursor: pointer;">Войти по коду (старый способ)</summary>
      <div class="party-actions" style="margin-top: 8px;">
        <input id="party-join-code" type="text" maxlength="8" placeholder="КОД" class="party-code-input" />
        <button id="btn-party-join" type="button" class="puzzle-secondary">Войти</button>
      </div>
    </details>

    <div id="party-error" class="party-error" hidden></div>
  `;
  body.querySelector("#btn-party-create").addEventListener("click", () => {
    partyCreateAndInvite().catch((e) => _partyShowError(e));
  });
  body.querySelector("#btn-party-create-empty").addEventListener("click", () => {
    partyCreate().catch((e) => _partyShowError(e));
  });
  body.querySelector("#btn-party-join").addEventListener("click", () => {
    const code = (body.querySelector("#party-join-code").value || "").trim().toUpperCase();
    if (!code) return;
    partyJoin(code).catch((e) => _partyShowError(e));
  });
  body.querySelector("#party-join-code").addEventListener("keydown", (e) => {
    if (e.key === "Enter") body.querySelector("#btn-party-join").click();
  });
  // Async fills.
  _renderFriendPicker().catch(() => {});
  _renderOpenPartiesList().catch(() => {});
}

function _partyShowError(e) {
  const errEl = document.getElementById("party-error");
  if (!errEl) return;
  errEl.hidden = false;
  errEl.textContent = e && e.message ? e.message : "Ошибка";
}

function closePartyModal() {
  const m = document.getElementById("party-modal");
  if (m) m.hidden = true;
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
  state.party.code = code;
  state.party.active = true;
  state.party.status = "lobby";
  state.party.finalResults = null;
  state.party.scoreboard = [];
  state.party.members = [];
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
      state.party.members = Array.isArray(msg.members) ? msg.members : [];
      if (state.party.status === "lobby") renderPartyLobby();
      break;
    case "start":
      state.party.status = "playing";
      state.party.endsAt = msg.ends_at || 0;
      state.party.selfScore = 0;
      closePartyModal();
      setView("puzzle");
      _partyMountSidePanel();
      _partyStartCountdown();
      if (msg.your_puzzle) startPuzzle(_partyAdaptPuzzle(msg.your_puzzle));
      break;
    case "match_state":
      state.party.endsAt = msg.ends_at || state.party.endsAt;
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
    case "finish":
      state.party.status = "finished";
      state.party.finalResults = Array.isArray(msg.results) ? msg.results : [];
      state.party.active = false;
      if (state.party.countdownInterval) {
        clearInterval(state.party.countdownInterval);
        state.party.countdownInterval = null;
      }
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

// Broadcast the player's current FEN to spectators (no-op outside a
// live party). Throttling is handled server-side.
function _partyReportPosition(fen) {
  if (!state.party.active || state.party.status !== "playing") return;
  const ws = state.party.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ type: "position", fen: String(fen || "") }));
  } catch (_) { /* already closed */ }
}

// Pointer relay so spectators can see what the player is doing
// between moves (cursor over a square, dragging a piece). Bandwidth:
// one JSON message every ~33ms while the cursor is over the board, so
// at most ~30 msgs/sec — small per-player.
let _cursorLastSendTs = 0;
let _cursorLastPayload = "";
const _CURSOR_THROTTLE_MS = 33;
function _partyReportCursor(payload) {
  if (!state.party.active || state.party.status !== "playing") return;
  const ws = state.party.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
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
  const isPartyActive = () => (
    state.party && state.party.active && state.party.status === "playing"
  );
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
    });
  };
  const onLeave = () => {
    if (!isPartyActive()) return;
    // Clear the cursor on spectator side by sending an out-of-bounds
    // position; the server clamps to [-0.05, 1.05] and the spectator
    // CSS hides the dot when outside the board.
    _partyReportCursor({ x: -1, y: -1, flipped: false, selected: "", dragging: false });
  };
  const onDragStart = () => {
    if (!isPartyActive()) return;
    window.__partyCursorDragging = true;
  };
  const onDragEnd = () => {
    if (!isPartyActive()) return;
    window.__partyCursorDragging = false;
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
}
_installPartyCursorTracking();

function renderPartyLobby() {
  const body = _partyEnsureModal();
  if (!body) return;
  const m = state.party;
  const isHost = m.host_id === state.user.client_id;
  const memberRows = (m.members || []).map((mem) => `
    <li class="party-member ${mem.online ? "is-online" : "is-offline"}">
      <span class="party-avatar">${escapeHtml(mem.avatar || "♟")}</span>
      <span class="party-name">${escapeHtml(mem.nickname || "Гость")}</span>
      ${mem.is_host ? `<span class="party-tag party-tag-host">host</span>` : ""}
      ${!mem.online ? `<span class="party-tag party-tag-off">offline</span>` : ""}
    </li>
  `).join("");
  body.innerHTML = `
    <header class="party-header">
      <h2>🎉 Party — лобби</h2>
      <p class="muted">Код для приглашения: <code class="party-code-pill">${escapeHtml(m.code || "")}</code></p>
    </header>
    <ul class="party-members">${memberRows || `<li class="party-empty">Пока никого…</li>`}</ul>
    <div class="party-actions">
      ${isHost
        ? `<button id="btn-party-start" type="button" class="puzzle-primary">Начать матч (10 мин)</button>`
        : `<div class="muted">Ждём, пока хост запустит матч…</div>`}
      <button id="btn-party-leave" type="button" class="puzzle-ghost">Выйти</button>
    </div>
    <div id="party-error" class="party-error" hidden></div>
  `;
  body.querySelector("#btn-party-leave")?.addEventListener("click", () => {
    leaveParty();
  });
  body.querySelector("#btn-party-start")?.addEventListener("click", (ev) => {
    const btn = ev.currentTarget;
    // Hard guard against the user clicking 'Start' multiple times
    // before the server's puzzle response arrives — extra sends were
    // ignored on the server, but the round-trip is long enough on a
    // big puzzle bank that the user can rack up several clicks. We
    // disable the button immediately and re-enable on error / leave.
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "Запускаем матч…";
    const ws = state.party.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "start" }));
    } else {
      btn.disabled = false;
      btn.textContent = "Начать матч (10 мин)";
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
  // fresh puzzle now so they don't sit on an empty board.
  if (state.view === "puzzle") {
    state.puzzle.needsNextOnReturn = false;
    loadNextPuzzle();
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
  if (host) return host;
  host = document.createElement("aside");
  host.id = "party-side-panel";
  host.className = "party-side-panel";
  document.body.appendChild(host);
  return host;
}

function _partyUnmountSidePanel() {
  const host = document.getElementById("party-side-panel");
  if (host) host.remove();
}

function _partyRenderHud() {
  _partyRenderScoreboard();
}

function _partyRenderScoreboard() {
  const host = document.getElementById("party-side-panel");
  if (!host) return;
  const me = state.user.client_id;
  const rows = (state.party.scoreboard || []).map((r, i) => `
    <li class="party-row ${r.client_id === me ? "is-self" : ""}">
      <span class="party-rank">#${i + 1}</span>
      <span class="party-avatar">${escapeHtml(r.avatar || "♟")}</span>
      <span class="party-name">${escapeHtml(r.nickname || "Гость")}</span>
      <span class="party-score">${Number(r.score || 0)}</span>
      <span class="party-solved">✔ ${Number(r.solved || 0)}</span>
    </li>
  `).join("");
  const timer = state.party.status === "playing"
    ? _formatPartyTimeLeft(state.party.endsAt)
    : "—";
  host.innerHTML = `
    <header class="party-side-header">
      <span class="party-side-title">🎉 Party</span>
      <span class="party-side-timer">${timer}</span>
    </header>
    <ul class="party-side-list">${rows || `<li class="party-empty">…</li>`}</ul>
    <button id="btn-party-leave-side" type="button" class="puzzle-ghost party-side-leave">Выйти из пати</button>
  `;
  host.querySelector("#btn-party-leave-side")?.addEventListener("click", leaveParty);
}

function _partyShowResults() {
  const body = _partyEnsureModal();
  if (!body) return;
  _partyUnmountSidePanel();
  const rows = (state.party.finalResults || []).map((r) => `
    <li class="party-result-row ${r.client_id === state.user.client_id ? "is-self" : ""}">
      <span class="party-rank">#${r.rank}</span>
      <span class="party-avatar">${escapeHtml(r.avatar || "♟")}</span>
      <span class="party-name">${escapeHtml(r.nickname || "Гость")}</span>
      <span class="party-score">${Number(r.score || 0)} pts</span>
      <span class="party-solved">✔ ${Number(r.solved || 0)}</span>
      <span class="party-elo">+${Number(r.party_elo || 0)} elo (party)</span>
    </li>
  `).join("");
  body.innerHTML = `
    <header class="party-header">
      <h2>🏁 Итоги пати</h2>
      <p class="muted">Результат сохранён в истории профиля каждого участника. На официальный рейтинг это не влияет.</p>
    </header>
    <ol class="party-results">${rows || `<li class="party-empty">Никто ничего не решил.</li>`}</ol>
    <div class="party-actions">
      <button id="btn-party-close-results" type="button" class="puzzle-primary">Закрыть</button>
    </div>
  `;
  body.querySelector("#btn-party-close-results")?.addEventListener("click", () => {
    closePartyModal();
    state.party.ws = null;
    state.party.status = "lobby";
    state.party.finalResults = null;
  });
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
        _showInfoToast(`✔ ${msg.invitation.host_id === state.user.client_id ? "Кент принял твоё приглашение" : "Принято"}`);
      }
      break;
    case "invitation_declined":
      if (msg.invitation && msg.invitation.host_id === state.user.client_id) {
        _showInfoToast(`Кент отклонил приглашение`);
      }
      break;
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
      <span class="toast-avatar">${escapeHtml(inv.host_avatar || "♟")}</span>
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

async function _renderFriendPicker() {
  const host = document.getElementById("party-friend-picker");
  if (!host) return;
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
      <label class="party-friend-row">
        <input type="checkbox" class="party-friend-cb" value="${escapeHtml(u.client_id)}" />
        <span class="toast-avatar">${escapeHtml(u.avatar || "♟")}</span>
        <span class="party-friend-name">${escapeHtml(u.nickname || "Гость")}</span>
        <span class="party-friend-meta">${recent ? "● онлайн" : ""} ${Number(u.rating || 1500)} elo</span>
      </label>
    `;
  }).join("");
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
        <span class="toast-avatar">${escapeHtml(p.host_avatar || "♟")}</span>
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

async function partyCreateAndInvite() {
  // Gather selected friend IDs first; we'll fire one invite per checkbox.
  const checked = Array.from(
    document.querySelectorAll("#party-friend-picker .party-friend-cb:checked")
  ).map((cb) => cb.value).filter(Boolean);
  // Create the party (returns code) then invite each.
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
  if (checked.length) {
    await Promise.allSettled(
      checked.map((targetId) => fetch("/api/party/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: state.user.client_id,
          target_id: targetId,
          code: data.code,
        }),
      }))
    );
  }
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
  const panel = document.getElementById("spectator-panel");
  if (panel) panel.remove();
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

  panel.innerHTML = `
    <div class="spectator-header">
      <span class="spectator-title">🔭 Наблюдатель</span>
      <span class="spectator-meta">${escapeHtml(sp.code || "")} · ${escapeHtml(timer)}</span>
      <span class="spectator-spacer"></span>
      <button type="button" class="spectator-toggle ${sp.mode === "single" ? "is-active" : ""}" data-mode="single">Одна доска</button>
      <button type="button" class="spectator-toggle ${sp.mode === "grid" ? "is-active" : ""}" data-mode="grid">Все доски</button>
      <button type="button" class="spectator-leave">Выйти</button>
    </div>
    <div class="spectator-body">
      <aside class="spectator-side">
        <h3>Игроки</h3>
        ${players.map((p) => `
          <div class="spectator-player-row ${p.client_id === sp.selectedId ? "is-selected" : ""}" data-cid="${escapeHtml(p.client_id)}">
            <span class="toast-avatar">${escapeHtml(p.avatar || "♟")}</span>
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
  return `
    <div class="spectator-single">
      <div class="board-host">${_renderMiniBoardFromFen(fen, p)}</div>
      <div class="meta-host">
        <h3>${escapeHtml(p.nickname || "Гость")} ${escapeHtml(p.avatar || "")}</h3>
        <div class="row">Очки: <b>${Number(p.score || 0)}</b></div>
        <div class="row">Решено: ${Number(p.solved || 0)} · ошибок: ${Number(p.failed || 0)} · пропущено: ${Number(p.skipped || 0)}</div>
        <div class="row">Серия: ${streakHtml}${p.best_streak ? ` · макс ${Number(p.best_streak || 0)}` : ""}</div>
      </div>
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
              <span>${escapeHtml(p.avatar || "♟")}</span>
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
  // Cursor / selection overlay sourced from `player_state` cursor
  // updates relayed by the server.
  const cursor = (player && state.spectator && state.spectator.cursors)
    ? state.spectator.cursors[cid]
    : null;
  let overlayHtml = "";
  if (cursor && typeof cursor.x === "number" && typeof cursor.y === "number") {
    const x = Math.max(0, Math.min(1, cursor.x)) * 100;
    const y = Math.max(0, Math.min(1, cursor.y)) * 100;
    const cls = cursor.dragging ? "mb-cursor is-drag" : "mb-cursor";
    overlayHtml += `<div class="${cls}" style="left:${x.toFixed(2)}%;top:${y.toFixed(2)}%;"></div>`;
  }
  if (!fen || typeof fen !== "string") {
    return `<div class="${themeStyle.cls}" style="${themeStyle.style}">
      <div class="mb-ranks"></div>
      <div class="mini-board" data-cid="${escapeHtml(cid)}">${overlayHtml}</div>
      <div class="mb-corner"></div>
      <div class="mb-files"></div>
    </div>`;
  }
  const rows = fen.split(" ")[0].split("/");
  if (rows.length !== 8) return `<div class="${themeStyle.cls}" style="${themeStyle.style}"></div>`;
  // Selected square overlay (player highlighted a square they're
  // thinking about). 'a8' is top-left for white-at-bottom view.
  let selectedRC = null;
  if (cursor && cursor.selected && cursor.selected.length === 2) {
    const file = cursor.selected.charCodeAt(0) - "a".charCodeAt(0);
    const rank = parseInt(cursor.selected[1], 10);
    if (file >= 0 && file < 8 && rank >= 1 && rank <= 8) {
      selectedRC = { f: file, r: 8 - rank };
    }
  }
  const cells = [];
  for (let r = 0; r < 8; r++) {
    const row = rows[r];
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
      const isLight = (r + f) % 2 === 0;
      const piece = expanded[f];
      const pieceHtml = piece
        ? `<img class="mb-piece" src="${pieceSvgUrl(piece, pieceSet)}" alt="${piece}" draggable="false">`
        : "";
      const isSelected = selectedRC && selectedRC.r === r && selectedRC.f === f;
      const cls = `mb-square ${isLight ? "mb-light" : "mb-dark"}${isSelected ? " mb-selected" : ""}`;
      cells.push(`<div class="${cls}">${pieceHtml}</div>`);
    }
  }
  const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"]
    .map((r) => `<span>${r}</span>`).join("");
  const files = ["a", "b", "c", "d", "e", "f", "g", "h"]
    .map((f) => `<span>${f}</span>`).join("");
  return `
    <div class="${themeStyle.cls}" style="${themeStyle.style}">
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
