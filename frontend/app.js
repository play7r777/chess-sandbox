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

const PIECE_SET = "cburnett";

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

function pieceSvgUrl(piece) {
  const color = piece === piece.toUpperCase() ? "w" : "b";
  return `/static/pieces/${PIECE_SET}/${color}${piece.toUpperCase()}.svg`;
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
    <path fill="#95b776" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <path opacity="0.2" d="M13.6,6.55l-1.21-1.2a.39.39,0,0,0-.55,0L7.34,9.85,5.55,8.06a.39.39,0,0,0-.55,0L3.79,9.27a.39.39,0,0,0,0,.55l3.27,3.27a.39.39,0,0,0,.55,0l5.99-5.99A.39.39,0,0,0,13.6,6.55Z"/>
    <path fill="#fff" d="M13.6,6.05l-1.21-1.2a.39.39,0,0,0-.55,0L7.34,9.35,5.55,7.56a.39.39,0,0,0-.55,0L3.79,8.77a.39.39,0,0,0,0,.55l3.27,3.27a.39.39,0,0,0,.55,0l5.99-5.99A.39.39,0,0,0,13.6,6.05Z"/>
  </svg>`,
  good: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#95af6f" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <path opacity="0.2" d="M13.6,6.55l-1.21-1.2a.39.39,0,0,0-.55,0L7.34,9.85,5.55,8.06a.39.39,0,0,0-.55,0L3.79,9.27a.39.39,0,0,0,0,.55l3.27,3.27a.39.39,0,0,0,.55,0l5.99-5.99A.39.39,0,0,0,13.6,6.55Z"/>
    <path fill="#fff" d="M13.6,6.05l-1.21-1.2a.39.39,0,0,0-.55,0L7.34,9.35,5.55,7.56a.39.39,0,0,0-.55,0L3.79,8.77a.39.39,0,0,0,0,.55l3.27,3.27a.39.39,0,0,0,.55,0l5.99-5.99A.39.39,0,0,0,13.6,6.05Z"/>
  </svg>`,
  inaccuracy: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#f7c045" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <g opacity="0.2">
      <path d="M9.92,15a.27.27,0,0,1,0,.12.41.41,0,0,1-.07.11.32.32,0,0,1-.23.09H7.7a.25.25,0,0,1-.12,0,.27.27,0,0,1-.1-.08A.31.31,0,0,1,7.39,15V13.19A.32.32,0,0,1,7.48,13l.1-.07.12,0H9.59a.32.32,0,0,1,.23.09.61.61,0,0,1,.07.1.28.28,0,0,1,0,.13Zm2.2-7.17a3.1,3.1,0,0,1-.36.73,5.58,5.58,0,0,1-.49.6,6,6,0,0,1-.52.49,8,8,0,0,0-.65.63,1,1,0,0,0-.27.7v.22a.24.24,0,0,1,0,.12.17.17,0,0,1-.06.1.3.3,0,0,1-.1.07l-.12,0H7.79l-.12,0a.3.3,0,0,1-.1-.07.26.26,0,0,1-.07-.1.37.37,0,0,1,0-.12v-.35A2.42,2.42,0,0,1,7.61,10a2.55,2.55,0,0,1,.33-.66,3.38,3.38,0,0,1,.45-.55c.16-.15.33-.29.49-.42a7.73,7.73,0,0,0,.64-.64,1,1,0,0,0,.26-.67.77.77,0,0,0-.07-.34.75.75,0,0,0-.23-.27,1.16,1.16,0,0,0-.72-.24,1.61,1.61,0,0,0-.49.07,3,3,0,0,0-.41.18,1.41,1.41,0,0,0-.29.18l-.11.09a.5.5,0,0,1-.24.06A.31.31,0,0,1,7,6.69L6,5.48a.29.29,0,0,1,0-.4,1.36,1.36,0,0,1,.21-.2,3.07,3.07,0,0,1,.56-.38,5.38,5.38,0,0,1,.89-.37A3.75,3.75,0,0,1,8.9,4a4.07,4.07,0,0,1,1.2.19,4,4,0,0,1,1.09.56,2.76,2.76,0,0,1,.78.92,2.82,2.82,0,0,1,.28,1.28A3,3,0,0,1,12.12,7.85Z"/>
    </g>
    <path fill="#fff" d="M9.92,14.52a.27.27,0,0,1,0,.12.41.41,0,0,1-.07.11.32.32,0,0,1-.23.09H7.7a.25.25,0,0,1-.12,0,.27.27,0,0,1-.1-.08.31.31,0,0,1-.09-.22V12.69a.32.32,0,0,1,.09-.23l.1-.07.12,0H9.59a.32.32,0,0,1,.23.09.61.61,0,0,1,.07.1.28.28,0,0,1,0,.13Zm2.2-7.17a3.1,3.1,0,0,1-.36.73,5.58,5.58,0,0,1-.49.6,6,6,0,0,1-.52.49,8,8,0,0,0-.65.63,1,1,0,0,0-.27.7v.22a.24.24,0,0,1,0,.12.17.17,0,0,1-.06.1.3.3,0,0,1-.1.07l-.12,0H7.79l-.12,0a.3.3,0,0,1-.1-.07.26.26,0,0,1-.07-.1.37.37,0,0,1,0-.12v-.35a2.42,2.42,0,0,1,.13-.84,2.55,2.55,0,0,1,.33-.66,3.38,3.38,0,0,1,.45-.55c.16-.15.33-.29.49-.42a7.73,7.73,0,0,0,.64-.64,1,1,0,0,0,.26-.67.77.77,0,0,0-.07-.34A.75.75,0,0,0,9.48,6a1.16,1.16,0,0,0-.72-.24,1.61,1.61,0,0,0-.49.07A3,3,0,0,0,7.86,6a1.41,1.41,0,0,0-.29.18l-.11.09a.5.5,0,0,1-.24.06A.31.31,0,0,1,7,6.19L6,5a.29.29,0,0,1,0-.4,1.36,1.36,0,0,1,.21-.2A3.07,3.07,0,0,1,6.81,4a5.38,5.38,0,0,1,.89-.37,3.75,3.75,0,0,1,1.2-.17,4.07,4.07,0,0,1,1.2.19,4,4,0,0,1,1.09.56,2.76,2.76,0,0,1,.78.92,2.82,2.82,0,0,1,.28,1.28A3,3,0,0,1,12.12,7.35Z"/>
    <circle cx="8.65" cy="7.55" r="0.95" fill="#fff"/>
  </svg>`,
  forced: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 19" width="100%" height="100%">
    <path opacity="0.3" d="M9,.5a9,9,0,1,0,9,9A9,9,0,0,0,9,.5Z"/>
    <path fill="#95978e" d="M9,0a9,9,0,1,0,9,9A9,9,0,0,0,9,0Z"/>
    <path fill="#fff" d="M7.65,5.95a2.55,2.55,0,0,1,1.8.74l.79.79a.85.85,0,0,1,0,1.2.83.83,0,0,1-1.18,0L8.27,7.86a.92.92,0,0,0-.62-.26.84.84,0,0,0-.86.86.85.85,0,0,0,.26.62L8.05,10.1a.85.85,0,0,1,0,1.2.83.83,0,0,1-1.18,0L5.88,10.31A2.54,2.54,0,0,1,7.65,5.95Zm5.18,1.74a2.54,2.54,0,0,1-.78,4.36l-.79.79a2.54,2.54,0,0,1-3.6-3.59l.78-.78a.83.83,0,0,1,1.18,0,.85.85,0,0,1,0,1.2L8.83,10.4a.85.85,0,0,0,1.2,1.2L11,10.62a.86.86,0,0,0-1.2-1.2l-.39.39A.83.83,0,0,1,8.21,8.62l.39-.39A2.55,2.55,0,0,1,12.83,7.69Z"/>
  </svg>`,
};

function makeReviewBadge(cls) {
  const wrap = document.createElement("span");
  wrap.className = "review-badge cls-" + cls;
  wrap.innerHTML = REVIEW_BADGE_SVG[cls] || "";
  return wrap;
}

// Build a green SVG-arrow overlay over the board (Stockfish's best
// move + a couple of plies of the principal variation as fading
// translucent arrows behind it). Called every renderBoard().
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

  // Reusable arrowhead marker per opacity level.
  const defs = document.createElementNS(NS, "defs");
  const tints = [
    { id: "arrow-best", fill: "#5eaa46" },
    { id: "arrow-pv1",  fill: "rgba(94, 170, 70, 0.55)" },
    { id: "arrow-pv2",  fill: "rgba(94, 170, 70, 0.32)" },
  ];
  for (const t of tints) {
    const m = document.createElementNS(NS, "marker");
    m.setAttribute("id", t.id);
    m.setAttribute("viewBox", "0 0 10 10");
    m.setAttribute("refX", "7");
    m.setAttribute("refY", "5");
    m.setAttribute("markerWidth", "3.4");
    m.setAttribute("markerHeight", "3.4");
    m.setAttribute("orient", "auto");
    const tip = document.createElementNS(NS, "path");
    tip.setAttribute("d", "M0,1 L9,5 L0,9 L2.5,5 Z");
    tip.setAttribute("fill", t.fill);
    m.appendChild(tip);
    defs.appendChild(m);
  }
  svg.appendChild(defs);

  function drawArrow(fromSq, toSq, color, markerId, width) {
    const a = squareToBoardXY(fromSq);
    const b = squareToBoardXY(toSq);
    if (!a || !b) return;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.01) return;
    // Pull the line back from both ends a little so the arrow
    // sits *on* the squares instead of hiding the piece glyphs.
    const inset = 0.30;
    const x1 = a.x + (dx / len) * 0.18;
    const y1 = a.y + (dy / len) * 0.18;
    const x2 = b.x - (dx / len) * inset;
    const y2 = b.y - (dy / len) * inset;
    const ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", x1);
    ln.setAttribute("y1", y1);
    ln.setAttribute("x2", x2);
    ln.setAttribute("y2", y2);
    ln.setAttribute("stroke", color);
    ln.setAttribute("stroke-width", String(width));
    ln.setAttribute("stroke-linecap", "round");
    ln.setAttribute("marker-end", `url(#${markerId})`);
    svg.appendChild(ln);
  }

  // Render translucent PV arrows underneath the primary green one.
  // PV indices: 0 is the same as bestArrow, 1 is opponent's reply,
  // 2 is our planned follow-up. Show 1 + 2 as supporting context.
  if (hasPv) {
    for (let i = 1; i <= 2; i++) {
      const m = state.bestPv[i];
      if (!m || m.length < 4) continue;
      const fromSq = m.slice(0, 2);
      const toSq = m.slice(2, 4);
      const markerId = i === 1 ? "arrow-pv1" : "arrow-pv2";
      const color = i === 1 ? "rgba(94, 170, 70, 0.55)" : "rgba(94, 170, 70, 0.32)";
      drawArrow(fromSq, toSq, color, markerId, 0.18);
    }
  }
  if (hasBest) {
    drawArrow(state.bestArrow.from, state.bestArrow.to, "#5eaa46", "arrow-best", 0.24);
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

      // Coordinates on edges only.
      if (visualCol === 0) {
        const rk = document.createElement("span");
        rk.className = "coord rank";
        rk.textContent = sqName[1];
        cell.appendChild(rk);
      }
      if (visualRow === 7) {
        const fl = document.createElement("span");
        fl.className = "coord file";
        fl.textContent = sqName[0];
        cell.appendChild(fl);
      }

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
  syncMetaInputs();
  document.getElementById("fen-input").value = buildFen();
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
    });
    pieceEl.addEventListener("dragend", () => pieceEl.classList.remove("dragging"));
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
    return;
  }
  snapshotForUndo();
  loadFen(c.fen());
  state.lastMove = { from: move.from, to: move.to };
  state.selectedSquare = null;
  state.legalTargets = [];
  renderBoard();
  setStatus(`Ход: ${move.san}.`);
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

document.getElementById("btn-flip").addEventListener("click", () => {
  state.flipped = !state.flipped;
  renderBoard();
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
    return;
  }
  state.selectedSquare = null;
  state.legalTargets = [];
  applyChessMoveToBoard(move);
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
  "inaccuracy","mistake","blunder","miss",
];

const review = {
  game: null,
  analysis: null,
  activeIdx: -1,
  filter: new Set(),  // active classification filters; empty == show all
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

document.getElementById("btn-review-import").addEventListener("click", async () => {
  const src = document.getElementById("review-source").value.trim();
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
    document.getElementById("review-progress").textContent =
      `${r.headers.White || "?"} vs ${r.headers.Black || "?"} — ${r.moves_uci.length} полуходов. Жми «Анализировать».`;
    document.getElementById("btn-review-analyse").disabled = false;
    renderReviewMoves();
    document.getElementById("review-summary").innerHTML = "";
  } catch (err) {
    document.getElementById("review-progress").textContent = "Ошибка: " + err.message;
  } finally {
    document.getElementById("btn-review-import").disabled = false;
  }
});

document.getElementById("btn-review-analyse").addEventListener("click", async () => {
  if (!review.game) return;
  const depthRaw = document.getElementById("review-depth").value.trim();
  const movetimeRaw = document.getElementById("review-movetime").value.trim();
  const depth = depthRaw ? Math.max(6, Math.min(40, parseInt(depthRaw, 10) || 22)) : 22;
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
    renderKeyMoments(r.key_moments || []);
    renderReviewMoves();
    document.getElementById("review-progress").textContent =
      `Готово — ${r.moves.length} ходов проанализировано.`;
  } catch (err) {
    document.getElementById("review-progress").textContent = "Ошибка анализа: " + err.message;
  } finally {
    document.getElementById("btn-review-analyse").disabled = false;
  }
});

function renderReviewSummary(s) {
  const counts = s.counts || {};
  const root = document.getElementById("review-summary");
  root.innerHTML = `
    <div class="col"><h4>Белые</h4><div class="acc">${s.white.accuracy}%</div><div class="muted">ACPL ${s.white.acpl}</div></div>
    <div class="col"><h4>Чёрные</h4><div class="acc">${s.black.accuracy}%</div><div class="muted">ACPL ${s.black.acpl}</div></div>
    <div class="col" style="flex:1; min-width:280px;"><h4>Категории <span class="muted" id="review-filter-hint"></span></h4><div class="counts" id="review-pills"></div></div>
  `;
  const pillsHost = document.getElementById("review-pills");
  REVIEW_ORDER.forEach((k) => {
    const n = counts[k] || 0;
    const pill = document.createElement("span");
    pill.className = `pill cls-${k}` + (n === 0 ? " is-disabled" : "") + (review.filter.has(k) ? " is-active" : "");
    pill.dataset.cls = k;
    const xVisible = review.filter.has(k);
    pill.innerHTML = `${REVIEW_ICONS[k]} ${REVIEW_LABELS[k]}: ${n}${xVisible ? '<span class="x" title="Снять фильтр">×</span>' : ""}`;
    if (n > 0) {
      pill.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (review.filter.has(k)) review.filter.delete(k);
        else review.filter.add(k);
        renderReviewSummary(s);
        renderReviewMoves();
      });
    }
    pillsHost.appendChild(pill);
  });
  const hint = document.getElementById("review-filter-hint");
  if (review.filter.size > 0) {
    hint.textContent = `(показаны только: ${review.filter.size})`;
  } else {
    hint.textContent = "(клик — фильтр)";
  }
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

function jumpToReviewIdx(idx) {
  const game = review.game;
  if (!game) return;
  const moves = review.analysis ? review.analysis.moves : null;
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
    // Refresh opening explorer for the current position (fire-and-forget).
    renderOpeningExplorer(fen);
  } catch { /* ignore */ }
  // Update active list highlighting without full re-render of summary.
  document.querySelectorAll("#review-moves li").forEach((el, i) => {
    el.classList.toggle("is-active", i === idx);
  });
  refreshNavButtons();
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
    const sansHtml = m.best_pv_san.slice(0, 10)
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
}

document.getElementById("nav-first").addEventListener("click", () => jumpToReviewIdx(-1));
document.getElementById("nav-prev").addEventListener("click", () => {
  if (review.activeIdx > -1) jumpToReviewIdx(review.activeIdx - 1);
});
document.getElementById("nav-next").addEventListener("click", () => {
  const total = review.game ? review.game.moves_uci.length : 0;
  if (review.activeIdx < total - 1) jumpToReviewIdx(review.activeIdx + 1);
});
document.getElementById("nav-last").addEventListener("click", () => {
  if (review.game) jumpToReviewIdx(review.game.moves_uci.length - 1);
});

// ---------- Boot ----------

loadFen(STARTPOS_FEN);
renderPalette();
renderBoard();
setBoardMode(true);
refreshEngineStatus();

// Expose for debugging.
window.__chess = { state, buildFen, loadFen };
