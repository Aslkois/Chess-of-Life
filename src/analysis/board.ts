/**
 * Lightweight board model for tactical verification. All claims made by the
 * explanation, hint and classification layers are computed from these
 * functions on real board states – nothing is guessed from evaluations alone.
 */
import { Chess } from 'chess.js';

export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Color = 'w' | 'b';
export interface Piece { t: PieceType; c: Color }
export type Board = (Piece | null)[];

export const VALUE: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };
export const NAME: Record<PieceType, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };

export const sqName = (i: number) => 'abcdefgh'[i % 8] + String(Math.floor(i / 8) + 1);
export const sqIdx = (s: string) => (s.charCodeAt(0) - 97) + (parseInt(s[1], 10) - 1) * 8;
const fileOf = (i: number) => i % 8;
const rankOf = (i: number) => Math.floor(i / 8);
export const other = (c: Color): Color => (c === 'w' ? 'b' : 'w');

export function parseBoard(fen: string): Board {
  const b: Board = new Array(64).fill(null);
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r++) {
    let f = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) { f += parseInt(ch, 10); continue; }
      const c: Color = ch === ch.toUpperCase() ? 'w' : 'b';
      b[(7 - r) * 8 + f] = { t: ch.toLowerCase() as PieceType, c };
      f++;
    }
  }
  return b;
}

const KN = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KG = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function step(i: number, df: number, dr: number): number {
  const f = fileOf(i) + df;
  const r = rankOf(i) + dr;
  return f < 0 || f > 7 || r < 0 || r > 7 ? -1 : r * 8 + f;
}

/** Squares attacked (controlled) by the piece on `from`. */
export function attacks(b: Board, from: number): number[] {
  const p = b[from];
  if (!p) return [];
  const out: number[] = [];
  const slide = (dirs: number[][]) => {
    for (const [df, dr] of dirs) {
      let s = from;
      for (;;) {
        s = step(s, df, dr);
        if (s < 0) break;
        out.push(s);
        if (b[s]) break;
      }
    }
  };
  switch (p.t) {
    case 'p': {
      const dr = p.c === 'w' ? 1 : -1;
      for (const df of [-1, 1]) { const s = step(from, df, dr); if (s >= 0) out.push(s); }
      break;
    }
    case 'n': for (const [df, dr] of KN) { const s = step(from, df, dr); if (s >= 0) out.push(s); } break;
    case 'k': for (const [df, dr] of KG) { const s = step(from, df, dr); if (s >= 0) out.push(s); } break;
    case 'b': slide(DIAG); break;
    case 'r': slide(ORTH); break;
    case 'q': slide(DIAG); slide(ORTH); break;
  }
  return out;
}

export function attackersOf(b: Board, target: number, color: Color): number[] {
  const res: number[] = [];
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (p && p.c === color && attacks(b, i).includes(target)) res.push(i);
  }
  return res;
}

export function kingSquare(b: Board, color: Color): number {
  return b.findIndex((p) => p?.t === 'k' && p.c === color);
}

/**
 * Static exchange evaluation of moving the piece on `from` to `to` (capture
 * or not), assuming both sides keep recapturing on `to` with their least
 * valuable attacker and may stop at any time. Result in pawns for the mover.
 */
export function seeMove(b0: Board, from: number, to: number): number {
  const b = b0.slice();
  const mover = b[from]!;
  const gain: number[] = [];
  gain[0] = b[to] ? VALUE[b[to]!.t] : 0;
  let onSquare = mover;
  b[to] = mover;
  b[from] = null;
  let side = other(mover.c);
  let d = 0;
  for (;;) {
    const atk = attackersOf(b, to, side);
    if (!atk.length) break;
    // least valuable attacker; a king may only capture if the square is not defended
    atk.sort((x, y) => VALUE[b[x]!.t] - VALUE[b[y]!.t]);
    let pick = atk[0];
    if (b[pick]!.t === 'k') {
      const defenders = attackersOf(b, to, other(side));
      if (defenders.length) break;
      pick = atk[0];
    }
    d++;
    gain[d] = VALUE[onSquare.t] - gain[d - 1];
    onSquare = b[pick]!;
    b[to] = onSquare;
    b[pick] = null;
    side = other(side);
    if (onSquare.t === 'k') break;
  }
  // Negamax the swap list back to the first capture. Every entry 0..d is a
  // capture that really happened, so all of them take part (the textbook
  // `while (--d)` form assumes one extra *speculative* entry, which this loop
  // does not store – using it here silently dropped the last recapture).
  for (; d > 0; d--) gain[d - 1] = -Math.max(-gain[d - 1], gain[d]);
  return gain[0] || 0; // normalise -0
}

export interface Hanging { square: string; piece: Piece; loss: number; attackers: string[] }

/**
 * Pieces of `color` that the opponent can win material against right now by
 * a capture (positive static exchange). Pins are respected through chess.js
 * legality when a FEN with the opponent to move is supplied.
 */
export function hangingPieces(fen: string, color: Color): Hanging[] {
  const b = parseBoard(fen);
  const res: Hanging[] = [];
  const opp = other(color);
  const legal = legalCapturesFor(fen, opp);
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p || p.c !== color || p.t === 'k') continue;
    const atk = attackersOf(b, i, opp).filter((a) => legal === null || legal.has(sqName(a) + sqName(i)));
    if (!atk.length) continue;
    let best = 0;
    for (const a of atk) best = Math.max(best, seeMove(b, a, i));
    if (best > 0) res.push({ square: sqName(i), piece: p, loss: best, attackers: atk.map(sqName) });
  }
  return res.sort((x, y) => y.loss - x.loss);
}

/** Set of legal capture "fromto" strings for `color` (with that side to move), or null if not computable. */
export function legalCapturesFor(fen: string, color: Color): Set<string> | null {
  try {
    const parts = fen.split(' ');
    parts[1] = color;
    parts[3] = '-';
    const c = new Chess(parts.join(' '));
    return new Set(c.moves({ verbose: true }).filter((m) => m.captured).map((m) => m.from + m.to));
  } catch {
    return null;
  }
}

export function isDefended(b: Board, sq: number): boolean {
  const p = b[sq];
  if (!p) return false;
  return attackersOf(b, sq, p.c).length > 0;
}

/** Passed pawns of `color`. */
export function passedPawns(b: Board, color: Color): number[] {
  const res: number[] = [];
  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p || p.t !== 'p' || p.c !== color) continue;
    const f = fileOf(i);
    const r = rankOf(i);
    let blocked = false;
    for (let j = 0; j < 64 && !blocked; j++) {
      const q = b[j];
      if (!q || q.t !== 'p' || q.c === color) continue;
      if (Math.abs(fileOf(j) - f) > 1) continue;
      if (color === 'w' ? rankOf(j) > r : rankOf(j) < r) blocked = true;
    }
    if (!blocked) res.push(i);
  }
  return res;
}

/** Count of own pawns directly sheltering the king (files around it, one or two ranks ahead). */
export function pawnShield(b: Board, color: Color): { shield: number; kingSq: number; onBackRank: boolean } {
  const k = kingSquare(b, color);
  if (k < 0) return { shield: 0, kingSq: -1, onBackRank: false };
  const dr = color === 'w' ? 1 : -1;
  let shield = 0;
  for (const df of [-1, 0, 1]) {
    for (const d of [1, 2]) {
      const s = step(k, df, dr * d);
      if (s >= 0 && b[s]?.t === 'p' && b[s]!.c === color) { shield++; break; }
    }
  }
  return { shield, kingSq: k, onBackRank: rankOf(k) === (color === 'w' ? 0 : 7) };
}

/** Squares next to the king (king zone). */
export function kingZone(b: Board, color: Color): number[] {
  const k = kingSquare(b, color);
  if (k < 0) return [];
  return [k, ...KG.map(([df, dr]) => step(k, df, dr)).filter((s) => s >= 0)];
}

/** Flip side to move (null move). Returns null when illegal (side not to move is in check). */
export function nullMoveFen(fen: string): string | null {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  const f = parts.join(' ');
  try {
    const c = new Chess(f);
    // the side that just "passed" must not be giving check into a position where the mover could capture the king
    const b = parseBoard(f);
    const k = kingSquare(b, other(c.turn()));
    if (k >= 0 && attackersOf(b, k, c.turn()).length) return null;
    return f;
  } catch {
    return null;
  }
}

/** Mate-in-one moves available to the side to move. */
export function mateInOneMoves(fen: string): string[] {
  try {
    const c = new Chess(fen);
    const out: string[] = [];
    for (const m of c.moves({ verbose: true })) {
      c.move(m);
      if (c.isCheckmate()) out.push(m.san);
      c.undo();
    }
    return out;
  } catch {
    return [];
  }
}

export function materialBalance(b: Board): number {
  let s = 0;
  for (const p of b) if (p && p.t !== 'k') s += (p.c === 'w' ? 1 : -1) * VALUE[p.t];
  return s;
}

export function pieceCount(b: Board): number {
  return b.filter((p) => p && p.t !== 'k' && p.t !== 'p').length;
}

export type Phase = 'opening' | 'middlegame' | 'endgame';
export function gamePhase(fen: string, ply: number): Phase {
  const b = parseBoard(fen);
  let nonPawn = 0;
  for (const p of b) if (p && p.t !== 'k' && p.t !== 'p') nonPawn += VALUE[p.t];
  if (nonPawn <= 26) return 'endgame'; // e.g. at most R+B+minor each side
  if (ply <= 20) return 'opening';
  return 'middlegame';
}
