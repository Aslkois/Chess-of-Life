import { Chess } from 'chess.js';
import { positionKey } from '../chess/positionKey';
import { bookMoves } from '../analysis/openings';
import type { DrillRecord, RepertoireLine } from '../db/types';

/**
 * Opening repertoire and practice. A repertoire is a set of lines for one
 * colour; together they form a tree of positions (merged by position key, so
 * transpositions share their prepared move). Practice is completely separate
 * from game statistics: it never creates games and never touches ratings.
 */

export type Side = 'w' | 'b';
export interface RepMove { uci: string; san: string; lineIds: string[] }
export interface RepIndex {
  color: Side;
  /** position key → prepared moves from that position */
  at: Map<string, RepMove[]>;
  lines: RepertoireLine[];
}

const uciOf = (m: { from: string; to: string; promotion?: string }) => m.from + m.to + (m.promotion ?? '');

/** Normalise a move list (SAN or UCI) into SAN from the start position; throws on an illegal move. */
export function normaliseLine(moves: string[]): string[] {
  const c = new Chess();
  return moves.map((m, i) => {
    try {
      const mv = /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m) ? c.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] }) : c.move(m);
      return mv.san;
    } catch {
      throw new Error(`Move ${Math.floor(i / 2) + 1}${i % 2 ? '...' : '.'}${m} is not legal in this line.`);
    }
  });
}

export function buildRepertoire(lines: RepertoireLine[], color: Side): RepIndex {
  const at = new Map<string, RepMove[]>();
  const mine = lines.filter((l) => l.color === color);
  for (const l of mine) {
    const c = new Chess();
    for (const san of l.moves) {
      const key = positionKey(c.fen());
      let mv;
      try { mv = c.move(san); } catch { break; }
      const list = at.get(key) ?? [];
      const uci = uciOf(mv);
      const e = list.find((x) => x.uci === uci);
      if (e) { if (!e.lineIds.includes(l.id)) e.lineIds.push(l.id); } else list.push({ uci, san: mv.san, lineIds: [l.id] });
      at.set(key, list);
    }
  }
  return { color, at, lines: mine };
}

export const preparedAt = (idx: RepIndex, fen: string): RepMove[] => idx.at.get(positionKey(fen)) ?? [];

/**
 * Positions where the user's lines disagree: two different prepared moves for
 * the user in the same position. Practice accepts either, but the user should
 * know.
 */
export function conflicts(idx: RepIndex): { fen: string; moves: string[] }[] {
  const out: { fen: string; moves: string[] }[] = [];
  for (const [key, moves] of idx.at) {
    const turn = key.split(' ')[1];
    if (turn === idx.color && moves.length > 1) out.push({ fen: key, moves: moves.map((m) => m.san) });
  }
  return out;
}

// ---------------- practice ----------------

export interface PracticeState {
  color: Side;
  fens: string[];
  sans: string[];
  ucis: string[];
  /** 'mine': the user is to move and the repertoire has an answer; 'theirs': the training opponent moves next */
  status: 'mine' | 'theirs' | 'complete' | 'uncovered';
  /** wrong tries in the current position (unlimited) */
  triesHere: number;
  /** the user asked to be shown the move here */
  revealed: boolean;
  /** decisions answered right at the first try / with retries or a reveal */
  firstTry: number;
  missed: number;
  /** the last wrong move, for feedback */
  lastWrong: { san: string; uci: string } | null;
  /** the opponent left the prepared lines with this move (only catalogued moves are used) */
  deviation: { san: string; ply: number } | null;
}

function statusAt(idx: RepIndex, fen: string): PracticeState['status'] {
  const turn = new Chess(fen).turn();
  const prepared = preparedAt(idx, fen);
  if (turn === idx.color) return prepared.length ? 'mine' : 'complete';
  return prepared.length ? 'theirs' : 'complete';
}

export function startPractice(idx: RepIndex): PracticeState {
  const fen = new Chess().fen();
  return { color: idx.color, fens: [fen], sans: [], ucis: [], status: statusAt(idx, fen), triesHere: 0, revealed: false, firstTry: 0, missed: 0, lastWrong: null, deviation: null };
}

const cur = (s: PracticeState) => s.fens[s.fens.length - 1];

function advance(s: PracticeState, idx: RepIndex, uci: string): PracticeState {
  const c = new Chess(cur(s));
  const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const fen = c.fen();
  return { ...s, fens: [...s.fens, fen], sans: [...s.sans, mv.san], ucis: [...s.ucis, uciOf(mv)], status: statusAt(idx, fen), triesHere: 0, revealed: false, lastWrong: null };
}

export interface TryResult { state: PracticeState; correct: boolean; expected: RepMove[]; firstTry: boolean }

/** The user tries a move. Wrong moves are not played; the user can retry as often as they like. */
export function tryMove(s: PracticeState, idx: RepIndex, move: { from: string; to: string; promotion?: string }): TryResult {
  if (s.status !== 'mine') throw new Error('Not your move in this line.');
  const c = new Chess(cur(s));
  const mv = c.move(move); // throws if illegal
  const uci = uciOf(mv);
  const expected = preparedAt(idx, cur(s));
  if (expected.some((e) => e.uci === uci)) {
    const first = s.triesHere === 0 && !s.revealed;
    const next = advance(s, idx, uci);
    return { state: { ...next, firstTry: s.firstTry + (first ? 1 : 0), missed: s.missed + (first ? 0 : 1) }, correct: true, expected, firstTry: first };
  }
  return { state: { ...s, triesHere: s.triesHere + 1, lastWrong: { san: mv.san, uci } }, correct: false, expected, firstTry: false };
}

export function reveal(s: PracticeState, idx: RepIndex): { state: PracticeState; expected: RepMove[] } {
  return { state: { ...s, revealed: true }, expected: preparedAt(idx, cur(s)) };
}

/**
 * The training opponent's move: one of the prepared replies in the user's
 * lines (choosing more often where the user's next decision is weakest). With
 * `deviate`, it sometimes plays a catalogued move the repertoire does not
 * cover, to test what happens off the prepared path.
 */
export function opponentMove(s: PracticeState, idx: RepIndex, rand: () => number, opts: { deviate?: boolean; weakness?: (fenAfter: string) => number } = {}): PracticeState {
  if (s.status !== 'theirs') return s;
  const fen = cur(s);
  const prepared = preparedAt(idx, fen);
  if (opts.deviate) {
    const others = bookMoves(fen).filter((u) => !prepared.some((p) => p.uci === u));
    if (others.length && rand() < 0.25) {
      const u = others[Math.floor(rand() * others.length)];
      const next = advance(s, idx, u);
      const covered = next.status === 'mine';
      return { ...next, status: covered ? 'mine' : 'uncovered', deviation: covered ? null : { san: next.sans[next.sans.length - 1], ply: next.sans.length - 1 } };
    }
  }
  const weights = prepared.map((p) => {
    const c = new Chess(fen);
    c.move({ from: p.uci.slice(0, 2), to: p.uci.slice(2, 4), promotion: p.uci[4] });
    return 1 + Math.max(0, opts.weakness?.(c.fen()) ?? 0);
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rand() * total;
  let pick = prepared[0];
  for (let i = 0; i < prepared.length; i++) { r -= weights[i]; if (r <= 0) { pick = prepared[i]; break; } }
  return advance(s, idx, pick.uci);
}

/** Take the practice line back to before the user's last decision. */
export function practiceBack(s: PracticeState, idx: RepIndex): PracticeState {
  let n = s.fens.length - 1;
  if (n === 0) return s;
  // go back to the last position where it was the user's turn
  do { n--; } while (n > 0 && new Chess(s.fens[n]).turn() !== s.color);
  const fens = s.fens.slice(0, n + 1);
  return { ...s, fens, sans: s.sans.slice(0, n), ucis: s.ucis.slice(0, n), status: statusAt(idx, fens[n]), triesHere: 0, revealed: false, lastWrong: null, deviation: null };
}

// ---------------- remembering what is forgotten ----------------

export const drillId = (color: Side, fen: string) => `${color}|${positionKey(fen)}`;

/** Update the practice record of one decision. */
export function recordDrill(prev: DrillRecord | undefined, color: Side, fen: string, expected: string[], firstTry: boolean, wrong: string[], now = Date.now()): DrillRecord {
  const r: DrillRecord = prev ?? { id: drillId(color, fen), color, fen, expected, attempts: 0, firstTry: 0, misses: 0, streak: 0, lastPracticed: 0, wrong: [] };
  return {
    ...r,
    expected,
    attempts: r.attempts + 1,
    firstTry: r.firstTry + (firstTry ? 1 : 0),
    misses: r.misses + (firstTry ? 0 : 1),
    streak: firstTry ? r.streak + 1 : 0,
    lastPracticed: now,
    lastMissed: firstTry ? r.lastMissed : now,
    wrong: [...wrong, ...r.wrong].slice(0, 5),
  };
}

/** How "forgotten" a decision is: recent misses count most; a streak of correct answers wears it off. */
export function weakness(r: DrillRecord | undefined): number {
  if (!r) return 0;
  return Math.max(0, r.misses * 2 - r.streak * 1.5 - r.firstTry * 0.25);
}

/** Decisions to revise, weakest first (only those with at least one miss). */
export function forgotten(records: DrillRecord[], color?: Side): DrillRecord[] {
  return records.filter((r) => r.misses > 0 && (!color || r.color === color) && weakness(r) > 0).sort((a, b) => weakness(b) - weakness(a) || (b.lastMissed ?? 0) - (a.lastMissed ?? 0));
}
