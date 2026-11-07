import { Chess, type Color } from 'chess.js';
import { positionKey } from './positionKey';

export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';
export type EndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient-material'
  | 'fivefold-repetition'
  | 'seventy-five-move'
  | 'threefold-repetition'
  | 'fifty-move'
  | 'resignation'
  | 'timeout'
  | 'timeout-vs-insufficient'
  | 'agreement';

export type DrawClaim = 'threefold-repetition' | 'fifty-move';

export interface GameStatus {
  over: boolean;
  result: GameResult;
  reason?: EndReason;
  /** Draws the side to move may claim (FIDE 9.2 / 9.3). They do not end the game automatically. */
  claimable: DrawClaim[];
  inCheck: boolean;
  turn: Color;
  repetitionCount: number;
}

export const REASON_TEXT: Record<EndReason, string> = {
  checkmate: 'Checkmate',
  stalemate: 'Stalemate',
  'insufficient-material': 'Insufficient material',
  'fivefold-repetition': 'Fivefold repetition',
  'seventy-five-move': '75-move rule',
  'threefold-repetition': 'Threefold repetition (claimed)',
  'fifty-move': '50-move rule (claimed)',
  resignation: 'Resignation',
  timeout: 'Time forfeit',
  'timeout-vs-insufficient': 'Flag fell, but the opponent cannot checkmate',
  agreement: 'Draw by agreement',
};

/**
 * Authoritative game status from the full list of positions (FENs) since the
 * start position, ending with the current one. Automatic terminations follow
 * FIDE: checkmate, stalemate, dead position (insufficient material), fivefold
 * repetition, 75-move rule. Threefold repetition and the 50-move rule are
 * claimable, not automatic.
 */
export function gameStatus(fenHistory: string[]): GameStatus {
  const fen = fenHistory[fenHistory.length - 1];
  const c = new Chess(fen);
  const turn = c.turn();
  const key = positionKey(fen);
  const repetitionCount = fenHistory.reduce((n, f) => n + (positionKey(f) === key ? 1 : 0), 0);
  const halfmove = parseInt(fen.split(' ')[4] ?? '0', 10) || 0;
  const inCheck = c.inCheck();
  const base = { claimable: [] as DrawClaim[], inCheck, turn, repetitionCount };
  if (c.isCheckmate()) return { ...base, over: true, result: turn === 'w' ? '0-1' : '1-0', reason: 'checkmate' };
  if (c.isStalemate()) return { ...base, over: true, result: '1/2-1/2', reason: 'stalemate' };
  if (c.isInsufficientMaterial()) return { ...base, over: true, result: '1/2-1/2', reason: 'insufficient-material' };
  if (repetitionCount >= 5) return { ...base, over: true, result: '1/2-1/2', reason: 'fivefold-repetition' };
  if (halfmove >= 150) return { ...base, over: true, result: '1/2-1/2', reason: 'seventy-five-move' };
  const claimable: DrawClaim[] = [];
  if (repetitionCount >= 3) claimable.push('threefold-repetition');
  if (halfmove >= 100) claimable.push('fifty-move');
  return { ...base, claimable, over: false, result: '*' };
}

/**
 * Can `color` still deliver checkmate by any sequence of legal moves?
 * Used for FIDE 6.9: a player whose flag falls loses unless the opponent
 * cannot checkmate, in which case the game is drawn.
 * Conservative implementation: false only for a lone king, or a lone minor
 * piece against a bare king / when the whole position is a dead draw.
 */
export function canCheckmate(fen: string, color: Color): boolean {
  const c = new Chess(fen);
  if (c.isInsufficientMaterial()) return false;
  const mine: string[] = [];
  const theirs: string[] = [];
  for (const row of c.board()) for (const sq of row) if (sq && sq.type !== 'k') (sq.color === color ? mine : theirs).push(sq.type);
  if (mine.length === 0) return false;
  if (mine.length === 1 && (mine[0] === 'n' || mine[0] === 'b') && theirs.length === 0) return false;
  return true;
}

export function timeoutResult(fen: string, flagged: Color): { result: GameResult; reason: EndReason } {
  const opponent: Color = flagged === 'w' ? 'b' : 'w';
  if (!canCheckmate(fen, opponent)) return { result: '1/2-1/2', reason: 'timeout-vs-insufficient' };
  return { result: flagged === 'w' ? '0-1' : '1-0', reason: 'timeout' };
}

export function resignResult(resigning: Color): { result: GameResult; reason: EndReason } {
  return { result: resigning === 'w' ? '0-1' : '1-0', reason: 'resignation' };
}

export const PIECE_VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

export function materialCount(fen: string): { w: number; b: number; diff: number } {
  const c = new Chess(fen);
  let w = 0;
  let b = 0;
  for (const row of c.board()) for (const sq of row) if (sq) (sq.color === 'w' ? (w += PIECE_VALUE[sq.type]) : (b += PIECE_VALUE[sq.type]));
  return { w, b, diff: w - b };
}

const START_COUNTS: Record<string, number> = { p: 8, n: 2, b: 2, r: 2, q: 1 };

/** Pieces captured from each side (relative to the standard set, promotions accounted as best we can). */
export function capturedPieces(fen: string): { byWhite: string[]; byBlack: string[] } {
  const c = new Chess(fen);
  const counts = { w: { p: 0, n: 0, b: 0, r: 0, q: 0 } as Record<string, number>, b: { p: 0, n: 0, b: 0, r: 0, q: 0 } as Record<string, number> };
  for (const row of c.board()) for (const sq of row) if (sq && sq.type !== 'k') counts[sq.color][sq.type]++;
  const missing = (col: 'w' | 'b') => {
    const out: string[] = [];
    for (const t of ['q', 'r', 'b', 'n', 'p']) for (let i = counts[col][t]; i < START_COUNTS[t]; i++) out.push(t);
    return out;
  };
  return { byWhite: missing('b'), byBlack: missing('w') };
}
