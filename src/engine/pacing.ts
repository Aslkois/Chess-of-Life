import { Chess } from 'chess.js';
import type { AnalysisResult } from './controller';
import { AbortedError } from './controller';
import { winPercentPov } from './score';

/**
 * How long the Coach or the Rival appears to think before moving. It changes
 * only the pause, never which move is played. The pause includes the time the
 * engine already spent: only the remainder is waited, so a long search is not
 * followed by an extra delay. Ranges are this app's own design starting points
 * (no other site's timings are documented or copied):
 *
 *   forced or obvious   0.3–0.8 s      book move        0.3–0.9 s
 *   normal              0.6–1.5 s      complicated      1.2–2.5 s
 *   time pressure       0.1–0.5 s
 *
 * Randomness is controlled (seeded per move), the opponent's level stretches
 * complicated positions slightly, and on a clock the pause is capped so it can
 * never cost the game.
 */
export type OpponentSpeed = 'instant' | 'fast' | 'natural' | 'relaxed';
export type Situation = 'forced' | 'obvious' | 'book' | 'normal' | 'complex' | 'pressure';

export const RANGES: Record<Situation, [number, number]> = {
  forced: [300, 800],
  obvious: [300, 800],
  book: [300, 900],
  normal: [600, 1500],
  complex: [1200, 2500],
  pressure: [100, 500],
};
export const SPEED_FACTOR: Record<OpponentSpeed, number> = { instant: 0, fast: 0.5, natural: 1, relaxed: 1.6 };
/** Longest pause ever added, at Natural speed. */
export const MAX_PAUSE_MS = 2500;

export interface PaceInput {
  fen: string;
  /** the engine analysis the move was chosen from (MultiPV helps judge complexity) */
  analysis?: AnalysisResult | null;
  /** the move about to be played */
  uci: string;
  /** the move is a catalogued opening move */
  book?: boolean;
  /** opponent level 1–20 */
  level: number;
  /** the mover's remaining clock (ms); undefined when untimed */
  clockMs?: number;
  incrementMs?: number;
  /** time already spent choosing the move (ms) */
  engineMs: number;
  speed: OpponentSpeed;
  rand: () => number;
}

export function situation(p: Pick<PaceInput, 'fen' | 'analysis' | 'uci' | 'book' | 'clockMs' | 'incrementMs'>): Situation {
  const c = new Chess(p.fen);
  if (p.clockMs !== undefined && (p.clockMs < 10_000 || p.clockMs + (p.incrementMs ?? 0) * 5 < 20_000)) return 'pressure';
  const legal = c.moves({ verbose: true });
  if (legal.length <= 1) return 'forced';
  if (p.book) return 'book';
  const me = c.turn();
  const lines = p.analysis?.lines ?? [];
  const best = lines[0] ? winPercentPov(lines[0].score, me) : null;
  const second = lines[1] ? winPercentPov(lines[1].score, me) : null;
  const mv = legal.find((m) => m.from + m.to + (m.promotion ?? '') === p.uci);
  // obvious: mate in one, a recapture or the only reasonable move by a wide margin
  if (mv && mv.san.includes('#')) return 'obvious';
  if (best !== null && second !== null && best - second >= 30) return 'obvious';
  // complicated: several near-equal candidates in a position full of tactics
  const close = best !== null ? lines.filter((l) => best - winPercentPov(l.score, me) <= 5).length : 0;
  const forcing = legal.filter((m) => m.captured || m.san.includes('+')).length;
  if ((close >= 3 && legal.length >= 25) || (forcing >= 6 && close >= 2) || (best !== null && best > 20 && best < 80 && forcing >= 8)) return 'complex';
  return 'normal';
}

export interface Pace { situation: Situation; targetMs: number; waitMs: number }

export function thinkTime(p: PaceInput): Pace {
  const sit = situation(p);
  const factor = SPEED_FACTOR[p.speed];
  if (factor === 0) return { situation: sit, targetMs: 0, waitMs: 0 };
  const [lo, hi] = RANGES[sit];
  // a little more care in complicated positions from stronger levels (0.9×–1.1×)
  const lvl = sit === 'complex' ? 0.9 + (Math.max(1, Math.min(20, p.level)) - 1) / 95 : 1;
  // controlled randomness: a triangular-ish draw keeps most pauses mid-range
  const r = (p.rand() + p.rand()) / 2;
  let target = (lo + (hi - lo) * r) * lvl * factor;
  if (sit !== 'pressure') target = Math.min(target, MAX_PAUSE_MS * factor);
  if (p.clockMs !== undefined) {
    // never let a pause cost the game: at most a small share of the clock
    const budget = Math.max(0, Math.min(p.clockMs * 0.03 + (p.incrementMs ?? 0) * 0.5, p.clockMs - 3000));
    target = Math.min(target, budget);
  }
  target = Math.max(0, Math.round(target));
  return { situation: sit, targetMs: target, waitMs: Math.max(0, target - Math.max(0, p.engineMs)) };
}

/** A pause that ends early (with AbortedError) when the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new AbortedError()); return; }
    if (ms <= 0) { resolve(); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', on); resolve(); }, ms);
    const on = () => { clearTimeout(t); reject(new AbortedError()); };
    signal?.addEventListener('abort', on, { once: true });
  });
}
