import { Chess } from 'chess.js';
import type { AnalysisResult, EngineController } from './controller';
import { winPercentPov } from './score';
import { weightedPick } from '../util/rng';

/**
 * Calibrated strength ladder around Stockfish. A level fixes search depth,
 * the number of candidate moves considered and how many expected points a
 * chosen move may lose compared with the best one. Weaker levels therefore
 * play plausible, slightly inferior moves – never random blunders – and the
 * level never changes during a game.
 */
export interface StrengthProfile {
  level: number;
  depth: number;
  multipv: number;
  /** maximum expected points (win%) a chosen move may concede vs. the best move */
  tolerance: number;
  /** softness of the preference for better moves inside the tolerance */
  temperature: number;
}

export const MIN_LEVEL = 1;
export const MAX_LEVEL = 20;

export function strengthFor(level: number): StrengthProfile {
  const L = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round(level)));
  const tolerance = Math.max(0, 22 - L * 1.15);
  return {
    level: L,
    depth: Math.round(4 + L * 0.7),
    multipv: L >= 18 ? 2 : L >= 14 ? 3 : 5,
    tolerance,
    temperature: Math.max(0.6, tolerance / 3),
  };
}

/**
 * Internal (uncalibrated) rating anchor for each level, used by the Ranked
 * rating system. These are NOT FIDE or online-site ratings.
 */
export function levelRating(level: number): number {
  return 700 + 100 * (Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, level)) - 1);
}

export function levelForRating(r: number): number {
  return Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, Math.round((r - 700) / 100) + 1));
}

export interface Candidate {
  uci: string;
  san: string;
  epl: number;
  win: number;
  pv: string[];
  /** extra preference from a policy (style/exploitation), in temperature units */
  bonus: number;
  reasons: string[];
}

export function candidatesFrom(fen: string, analysis: AnalysisResult, tolerance: number): Candidate[] {
  const c = new Chess(fen);
  const side = c.turn();
  const legal = new Map(c.moves({ verbose: true }).map((m) => [m.from + m.to + (m.promotion ?? ''), m.san]));
  const lines = analysis.lines.filter((l) => l.pv.length && legal.has(l.pv[0]));
  if (!lines.length) return [];
  const bestWin = winPercentPov(lines[0].score, side);
  return lines
    .map((l) => {
      const win = winPercentPov(l.score, side);
      return { uci: l.pv[0], san: legal.get(l.pv[0])!, epl: Math.max(0, bestWin - win), win, pv: l.pv, bonus: 0, reasons: [] as string[] };
    })
    .filter((x, i) => i === 0 || x.epl <= tolerance);
}

export function chooseCandidate(cands: Candidate[], profile: StrengthProfile, rand: () => number): Candidate {
  const weights = cands.map((c) => Math.exp(-c.epl / profile.temperature + c.bonus));
  return weightedPick(cands, weights, rand);
}

/** Pick a legal move at a given strength. Always returns a legal move (validated by chess.js). */
export async function pickMove(
  engine: EngineController,
  fen: string,
  profile: StrengthProfile,
  rand: () => number,
  shape?: (cands: Candidate[]) => Candidate[] | Promise<Candidate[]>,
  signal?: AbortSignal,
): Promise<{ move: Candidate; analysis: AnalysisResult; considered: Candidate[] }> {
  const analysis = await engine.analyze({ fen, depth: profile.depth, multipv: profile.multipv, priority: 2, signal });
  let cands = candidatesFrom(fen, analysis, profile.tolerance);
  if (shape) cands = await shape(cands);
  if (!cands.length) {
    // fall back to any legal move (should not happen unless the engine failed)
    const c = new Chess(fen);
    const m = c.moves({ verbose: true })[0];
    const fallback: Candidate = { uci: m.from + m.to + (m.promotion ?? ''), san: m.san, epl: 0, win: 50, pv: [], bonus: 0, reasons: ['fallback'] };
    return { move: fallback, analysis, considered: [fallback] };
  }
  const move = chooseCandidate(cands, profile, rand);
  return { move, analysis, considered: cands };
}
