/**
 * Move classification – Chess of Life's own documented rules (see docs/ALGORITHMS.md).
 *
 * All thresholds work on "expected points" = winning chances in [0,100] from
 * the mover's point of view (logistic model of the engine score). Expected
 * points lost (EPL) is the drop from the best available move to the move played.
 */
import type { AnalysisResult } from '../engine/controller';
import { isMateScore, povCp, winPercentPov, type Score } from '../engine/score';
import { analyzeMove, type Motif } from './motifs';

export type Classification =
  | 'brilliant' | 'great' | 'best' | 'excellent' | 'good' | 'book'
  | 'inaccuracy' | 'mistake' | 'miss' | 'blunder';

export const CLASS_INFO: Record<Classification, { label: string; symbol: string; color: string; nag?: number }> = {
  brilliant: { label: 'Brilliant', symbol: '!!', color: '#2ec4b6', nag: 3 },
  great: { label: 'Great', symbol: '!', color: '#5b8def', nag: 1 },
  best: { label: 'Best', symbol: '★', color: '#7fb069' },
  excellent: { label: 'Excellent', symbol: '✓', color: '#9bc37a' },
  good: { label: 'Good', symbol: '•', color: '#a3a89a' },
  book: { label: 'Book', symbol: '📖', color: '#b08d57' },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', color: '#e6c34a', nag: 6 },
  mistake: { label: 'Mistake', symbol: '?', color: '#e8913a', nag: 2 },
  miss: { label: 'Miss', symbol: '✕', color: '#d9636c', nag: 2 },
  blunder: { label: 'Blunder', symbol: '??', color: '#e0474c', nag: 4 },
};

export const CLASS_ORDER: Classification[] = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];

export const THRESHOLDS = {
  excellent: 2,
  good: 5,
  inaccuracy: 10,
  mistake: 20,
  /** pv1 vs pv2 gap (expected points) for an "only move" */
  greatGap: 15,
  /** opponent error size that creates an opportunity */
  opportunity: 10,
  /** minimum material (pawns) given up for a sacrifice */
  sacrifice: 2,
};

export interface MoveContext {
  fenBefore: string;
  uci: string;
  color: 'w' | 'b';
  /** analysis of the position before the move (multipv >= 2 recommended) */
  before: AnalysisResult;
  /** analysis of the position after the move */
  after: AnalysisResult;
  /** EPL of the opponent's previous move, if known */
  prevOpponentEpl?: number;
  /** mover's win% before the opponent's previous move (to detect missed opportunities) */
  moverWinBeforeOpponentMove?: number;
  /** UCI of the previous move (for recapture detection) */
  prevUci?: string;
  /** the move was a catalogued opening continuation, and all prior moves were too */
  isBook?: boolean;
  /** number of legal moves in fenBefore */
  legalMoves: number;
  /** analysis depth considered final */
  targetDepth: number;
  /** result of verifying a sacrifice: mover's win% after the opponent accepts it (if checked) */
  sacrificeAcceptedWin?: number;
}

export interface MoveClassification {
  cls: Classification;
  epl: number;
  cpLoss: number;
  winBest: number;
  winAfter: number;
  scoreBest: Score;
  scoreAfter: Score;
  bestUci: string | null;
  bestPv: string[];
  accuracy: number;
  provisional: boolean;
  forced: boolean;
  depth: number;
  motifs: Motif[];
  sacrifice: number;
  /** a sacrifice that still needs engine verification before Brilliant can be awarded */
  needsSacrificeCheck: boolean;
  notes: string[];
}

/** Per-move accuracy from expected points lost (published Lichess curve, +1 uncertainty bonus). */
export function moveAccuracy(epl: number): number {
  const raw = 103.1668 * Math.exp(-0.04354 * Math.max(0, epl)) - 3.1669 + 1;
  return Math.max(0, Math.min(100, raw));
}

const clampCp = (x: number) => Math.max(-1000, Math.min(1000, x));

export function classifyMove(ctx: MoveContext): MoveClassification {
  const { before, after, color, uci } = ctx;
  const notes: string[] = [];
  const top = before.lines[0];
  const bestUci = before.bestmove ?? top?.pv[0] ?? null;
  const scoreBestRaw: Score = top?.score ?? { cp: 0 };
  const scoreAfter: Score = after.lines[0]?.score ?? { cp: 0 };
  const playedIsTop = bestUci === uci;
  // When the played move is the engine's choice the deeper search of the
  // resulting position is the more reliable estimate.
  const scoreBest = playedIsTop ? scoreAfter : scoreBestRaw;
  const winTop = winPercentPov(scoreBest, color);
  const winAfter = winPercentPov(scoreAfter, color);
  const winBest = Math.max(winTop, winAfter);
  const epl = Math.max(0, winBest - winAfter);
  const cpLoss = Math.max(0, clampCp(povCp(scoreBest, color)) - clampCp(povCp(scoreAfter, color)));
  const depth = Math.min(before.terminal ? 999 : before.depth, after.terminal ? 999 : after.depth);
  const provisional = depth < ctx.targetDepth;
  const forced = ctx.legalMoves === 1;
  let facts;
  try {
    facts = analyzeMove(ctx.fenBefore, uci);
  } catch {
    facts = { motifs: [] as Motif[], sacrifice: 0 };
  }
  const motifs = facts.motifs;
  const sacrifice = facts.sacrifice;
  const base = {
    epl, cpLoss, winBest, winAfter, scoreBest, scoreAfter, bestUci, bestPv: top?.pv ?? [], accuracy: moveAccuracy(epl),
    provisional, forced, depth, motifs, sacrifice, needsSacrificeCheck: false, notes,
  };

  if (forced) {
    notes.push('Only legal move.');
    return { ...base, cls: 'best', accuracy: 100 };
  }
  if (ctx.isBook && epl < THRESHOLDS.mistake) {
    return { ...base, cls: 'book' };
  }

  // Is the played move equivalent to the top line?
  const sameAsTop = playedIsTop || before.lines.some((l) => l.pv[0] === uci && sameScore(l.score, scoreBestRaw));

  // --- mate handling ---
  const hadMate = isMateScore(scoreBestRaw) && povCp(scoreBestRaw, color) > 0;
  const keepsMate = isMateScore(scoreAfter) && povCp(scoreAfter, color) > 0;
  if (hadMate && !keepsMate && !sameAsTop) {
    const n = Math.abs(scoreBestRaw.mate ?? 0);
    notes.push(`A forced mate${n ? ` in ${n}` : ''} was available.`);
    if (winAfter >= 99) return { ...base, cls: 'good' };
    if (n > 0 && n <= 5 && winAfter >= 50) return { ...base, cls: 'miss' };
  }
  if (hadMate && keepsMate && !sameAsTop) {
    const a = Math.abs(scoreBestRaw.mate ?? 0);
    const b = Math.abs(scoreAfter.mate ?? 0);
    return { ...base, cls: b - a <= 2 ? 'excellent' : 'good' };
  }

  // --- base bands ---
  let cls: Classification;
  if (sameAsTop) cls = 'best';
  else if (epl < THRESHOLDS.excellent) cls = 'excellent';
  else if (epl < THRESHOLDS.good) cls = 'good';
  else if (epl < THRESHOLDS.inaccuracy) cls = 'inaccuracy';
  else if (epl < THRESHOLDS.mistake) cls = 'mistake';
  else cls = 'blunder';

  // --- Miss: failing to exploit an opponent error without losing ground ---
  if ((cls === 'mistake' || cls === 'blunder' || cls === 'inaccuracy') && ctx.prevOpponentEpl !== undefined && ctx.moverWinBeforeOpponentMove !== undefined) {
    const opportunity = winBest - ctx.moverWinBeforeOpponentMove;
    if (ctx.prevOpponentEpl >= THRESHOLDS.opportunity && opportunity >= THRESHOLDS.opportunity && epl >= THRESHOLDS.inaccuracy && winAfter >= ctx.moverWinBeforeOpponentMove - 5) {
      notes.push(`The opponent's previous move gave you a chance worth about ${Math.round(opportunity)} expected points that was not taken.`);
      cls = 'miss';
    }
  }

  // --- Great: the only good move in a non-trivial position ---
  if (cls === 'best' && before.lines.length >= 2) {
    const second = winPercentPov(before.lines[1].score, color);
    const gap = winBest - second;
    const isRecapture = !!ctx.prevUci && ctx.prevUci.slice(2, 4) === uci.slice(2, 4) && motifs.some((m) => m.kind === 'capture' || m.kind === 'wins-hanging');
    const trivialCapture = motifs.some((m) => m.kind === 'wins-hanging' && (m.value ?? 0) >= 2);
    if (gap >= THRESHOLDS.greatGap && winBest >= 30 && winBest <= 97 && !isRecapture && !trivialCapture && !(isMateScore(scoreBestRaw) && Math.abs(scoreBestRaw.mate ?? 0) <= 1)) {
      notes.push(`Every other move was clearly worse (the next best option was ${Math.round(gap)} expected points behind).`);
      cls = 'great';
    }
  }

  // --- Brilliant: a sound, non-trivial sacrifice that is (nearly) best ---
  if ((cls === 'best' || cls === 'great' || cls === 'excellent') && epl < THRESHOLDS.excellent && sacrifice >= THRESHOLDS.sacrifice) {
    const nonTrivial = winBest < 90 || (ctx.moverWinBeforeOpponentMove ?? 50) < 90;
    const sound = winAfter >= 50;
    if (sound && nonTrivial) {
      if (ctx.sacrificeAcceptedWin === undefined) {
        base.needsSacrificeCheck = true;
      } else if (ctx.sacrificeAcceptedWin >= 50) {
        notes.push(`Sacrifices about ${sacrifice} pawns of material; accepting it does not refute the idea.`);
        cls = 'brilliant';
      }
    }
  }

  return { ...base, cls };
}

function sameScore(a: Score, b: Score): boolean {
  if (isMateScore(a) || isMateScore(b)) return a.mate === b.mate && a.mated === b.mated;
  return Math.abs((a.cp ?? 0) - (b.cp ?? 0)) <= 5;
}

/**
 * Game accuracy: average of a volatility-weighted mean and a harmonic mean of
 * per-move accuracies (method published by Lichess, implemented independently).
 */
export function gameAccuracy(moveAccuracies: number[], winsWhite: number[], colorMoves: boolean[]): number | null {
  // winsWhite: win% (White POV) for each position, length = moves + 1
  const n = moveAccuracies.length;
  if (!n) return null;
  const window = Math.max(2, Math.min(8, Math.floor(n / 10)));
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - window + 1);
    const slice = winsWhite.slice(lo, Math.max(lo + 2, i + 2));
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
    weights.push(Math.max(0.5, Math.min(12, sd)));
  }
  let wsum = 0;
  let wacc = 0;
  let hsum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!colorMoves[i]) continue;
    wsum += weights[i];
    wacc += weights[i] * moveAccuracies[i];
    hsum += 1 / Math.max(moveAccuracies[i], 1);
    count++;
  }
  if (!count) return null;
  const weighted = wacc / wsum;
  const harmonic = count / hsum;
  return (weighted + harmonic) / 2;
}
