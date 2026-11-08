import { Chess, type Square } from 'chess.js';
import { parseBoard, sqIdx, sqName, type Board, type Color } from '../analysis/board';

/**
 * Premoves: moves prepared during the opponent's turn. Because the opponent's
 * reply is unknown, a premove is accepted if the piece could make that move
 * by its movement pattern on the board as it will be after the earlier
 * premoves (pieces in the way are ignored, captures on empty squares are
 * allowed), like other chess apps do. Nothing about the opponent's intended
 * move is used. When it is the player's turn the first queued premove is
 * played only if it is legal in the real position; otherwise the whole queue
 * is cancelled.
 */
export interface Premove { from: string; to: string; promotion?: string }
export const MAX_PREMOVES = 5;

const onBoard = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;

export function premoveTargets(b: Board, from: string, color: Color, castling: string): string[] {
  const i = sqIdx(from);
  const p = b[i];
  if (!p || p.c !== color) return [];
  const f = i % 8, r = Math.floor(i / 8);
  const out: string[] = [];
  const add = (ff: number, rr: number) => { if (onBoard(ff, rr)) out.push(sqName(rr * 8 + ff)); };
  const ray = (df: number, dr: number) => { for (let k = 1; k < 8; k++) { if (!onBoard(f + df * k, r + dr * k)) break; add(f + df * k, r + dr * k); } };
  switch (p.t) {
    case 'p': {
      const dir = color === 'w' ? 1 : -1;
      add(f, r + dir);
      if ((color === 'w' && r === 1) || (color === 'b' && r === 6)) add(f, r + 2 * dir);
      add(f - 1, r + dir); add(f + 1, r + dir);
      break;
    }
    case 'n': for (const [a, c] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) add(f + a, r + c); break;
    case 'b': ray(1, 1); ray(1, -1); ray(-1, 1); ray(-1, -1); break;
    case 'r': ray(1, 0); ray(-1, 0); ray(0, 1); ray(0, -1); break;
    case 'q': ray(1, 1); ray(1, -1); ray(-1, 1); ray(-1, -1); ray(1, 0); ray(-1, 0); ray(0, 1); ray(0, -1); break;
    case 'k': {
      for (const [a, c] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) add(f + a, r + c);
      const home = color === 'w' ? 0 : 7;
      if (r === home && f === 4) {
        const k = color === 'w' ? 'K' : 'k';
        const q = color === 'w' ? 'Q' : 'q';
        if (castling.includes(k)) add(6, home);
        if (castling.includes(q)) add(2, home);
      }
      break;
    }
  }
  return out.filter((sq) => sq !== from);
}

/** The board as it would be after the queued premoves (opponent moves unknown). */
export function boardAfterPremoves(fen: string, queue: Premove[], color: Color): { board: Board; castling: string } {
  const b = parseBoard(fen);
  let castling = fen.split(' ')[2] ?? '-';
  for (const m of queue) {
    const from = sqIdx(m.from), to = sqIdx(m.to);
    const p = b[from];
    if (!p) continue;
    b[to] = m.promotion && p.t === 'p' ? { t: m.promotion as never, c: p.c } : p;
    b[from] = null;
    if (p.t === 'k') {
      const home = color === 'w' ? 0 : 7;
      if (from === home * 8 + 4 && to === home * 8 + 6) { b[home * 8 + 5] = b[home * 8 + 7]; b[home * 8 + 7] = null; }
      if (from === home * 8 + 4 && to === home * 8 + 2) { b[home * 8 + 3] = b[home * 8 + 0]; b[home * 8 + 0] = null; }
      castling = castling.replace(color === 'w' ? /[KQ]/g : /[kq]/g, '') || '-';
    }
  }
  return { board: b, castling };
}

/** Can `m` be queued after `queue` for `color`? Promotion defaults to a queen. */
export function validPremove(fen: string, queue: Premove[], m: Premove, color: Color): Premove | null {
  if (queue.length >= MAX_PREMOVES) return null;
  const { board, castling } = boardAfterPremoves(fen, queue, color);
  if (!premoveTargets(board, m.from, color, castling).includes(m.to)) return null;
  const p = board[sqIdx(m.from)]!;
  const last = color === 'w' ? '8' : '1';
  return p.t === 'p' && m.to[1] === last ? { ...m, promotion: m.promotion ?? 'q' } : { from: m.from, to: m.to };
}

/** Add a premove: with `multi` it is appended (up to five), otherwise it replaces the queue. */
export function addPremove(fen: string, queue: Premove[], m: Premove, color: Color, multi: boolean): Premove[] | null {
  const base = multi ? queue : [];
  const v = validPremove(fen, base, m, color);
  return v ? [...base, v] : null;
}

/**
 * When it is the player's turn: the first premove if it is legal now (as UCI),
 * and the rest of the queue; or `cancelled` when it is not legal any more.
 */
export function takePremove(fen: string, queue: Premove[]): { uci: string; rest: Premove[] } | { cancelled: true } | null {
  if (!queue.length) return null;
  const c = new Chess(fen);
  const m = queue[0];
  const legal = c.moves({ square: m.from as Square, verbose: true }).filter((x) => x.to === m.to);
  if (!legal.length) return { cancelled: true };
  const pick = legal.find((x) => (x.promotion ?? '') === (m.promotion ?? (legal[0].promotion ? 'q' : ''))) ?? legal[0];
  return { uci: pick.from + pick.to + (pick.promotion ?? ''), rest: queue.slice(1) };
}

/** Minimum time a premove takes on a running clock (ms). */
export const PREMOVE_TIME_MS = 100;
