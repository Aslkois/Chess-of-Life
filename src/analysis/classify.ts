/**
 * Move classification – Chess of Life's own documented rules (see docs/ALGORITHMS.md).
 *
 * All thresholds work on "expected points" = winning chances in [0,100] from
 * the mover's point of view (logistic model of the engine score). Expected
 * points lost (EPL) is the drop from the best available move to the move played.
 */
import { Chess } from 'chess.js';
import type { AnalysisResult } from '../engine/controller';
import { isMateScore, povCp, winPercentPov, type Score } from '../engine/score';
import { analyzeMove, type Motif } from './motifs';

export type Classification =
  | 'brilliant' | 'great' | 'best' | 'excellent' | 'good' | 'book'
  | 'inaccuracy' | 'mistake' | 'miss' | 'blunder';

export const CLASS_INFO: Record<Classification, { label: string; symbol: string; color: string; nag?: number }> = {
  brilliant: { label: 'Brilliant', symbol: '!!', color: '#1fbfad', nag: 3 },
  great: { label: 'Great', symbol: '!', color: '#5c93f0', nag: 1 },
  best: { label: 'Best', symbol: '★', color: '#7fb34a' },
  excellent: { label: 'Excellent', symbol: '✓', color: '#9ac35c' },
  good: { label: 'Good', symbol: '•', color: '#93a88b' },
  book: { label: 'Book', symbol: '📖', color: '#b08d66' },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!', color: '#eec35a', nag: 6 },
  mistake: { label: 'Mistake', symbol: '?', color: '#f09b48', nag: 2 },
  miss: { label: 'Miss', symbol: '✕', color: '#ef7462', nag: 2 },
  blunder: { label: 'Blunder', symbol: '??', color: '#e5443a', nag: 4 },
};

export const CLASS_ORDER: Classification[] = ['brilliant', 'great', 'best', 'excellent', 'good', 'book', 'inaccuracy', 'mistake', 'miss', 'blunder'];

/**
 * Expected-points bands (published by Chess.com for Classification V2) on our
 * 0–100 scale: Best 0, Excellent ≤ 2, Good ≤ 5, Inaccuracy ≤ 10, Mistake ≤ 20,
 * Blunder > 20. Upper bounds are inclusive.
 */
export const THRESHOLDS = {
  best: 0.05,
  excellent: 2,
  good: 5,
  inaccuracy: 10,
  mistake: 20,
  /** an opponent error at least this large creates an "opportunity" */
  opportunity: 10,
  /** minimum net material (pawns) the opponent must be able to win for a sacrifice: an exchange or more */
  sacrifice: 2,
  /** the mover is "completely winning" at or above this win% */
  completelyWinning: 90,
  /** a Brilliant must not leave the mover worse than this */
  soundAfter: 45,
  /** accepting a sacrifice must not cost the opponent more than this (else it is a trap, not a sacrifice) */
  meaningfulAccept: 15,
  /** "only move" gap between the best and second-best options */
  onlyMoveGap: 15,
};

/** Outcome bands in win% (mover POV): lost, worse, balanced, better, winning. */
export function outcomeBand(win: number): 0 | 1 | 2 | 3 | 4 {
  if (win < 20) return 0;
  if (win < 40) return 1;
  if (win <= 60) return 2;
  if (win < 80) return 3;
  return 4;
}
const BAND_NAME = ['lost', 'worse', 'balanced', 'better', 'winning'];

/**
 * Engine verification of a sacrifice: the opponent's best way of accepting
 * it, searched with `searchmoves` restricted to the acceptance captures.
 */
export interface SacrificeCheck {
  /** acceptance move that is best for the opponent */
  acceptUci: string;
  /** mover's winning chances after that acceptance */
  acceptWin: number;
  depth: number;
  /** some acceptance really wins the material (not recovered at once) */
  real: boolean;
}

export interface MoveContext {
  fenBefore: string;
  uci: string;
  color: 'w' | 'b';
  /** analysis of the position before the move (MultiPV ≥ 2 needed for Great/Brilliant) */
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
  /** engine verification of a sacrifice; `null` = checked but no acceptance could be evaluated */
  sacrificeCheck?: SacrificeCheck | null;
  /** number of legal replies the opponent has after the move (computed when absent) */
  opponentReplies?: number;
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
  /** legal captures that would win the offered material (for verification) */
  acceptances: string[];
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

/** Ordinary band for a given expected-points loss (inclusive upper bounds). */
export function bandFor(epl: number): Classification {
  if (epl <= THRESHOLDS.best) return 'best';
  if (epl <= THRESHOLDS.excellent) return 'excellent';
  if (epl <= THRESHOLDS.good) return 'good';
  if (epl <= THRESHOLDS.inaccuracy) return 'inaccuracy';
  if (epl <= THRESHOLDS.mistake) return 'mistake';
  return 'blunder';
}

/**
 * Classify one move. Precedence: forced → book → mate handling → Brilliant →
 * Great → Best → Miss → expected-points bands. Brilliant and Great are only
 * awarded on final-depth analysis with explicit evidence; otherwise the move
 * keeps its ordinary classification.
 */
export function classifyMove(input: MoveContext): MoveClassification {
  let ctx = input;
  const { before, after, color, uci } = ctx;
  const notes: string[] = [];
  const top = before.lines[0];
  const bestUci = before.bestmove ?? top?.pv[0] ?? null;
  const scoreTop: Score = top?.score ?? { cp: 0 };
  const scoreAfter: Score = after.lines[0]?.score ?? { cp: 0 };
  const playedIsTop = bestUci === uci;
  // When the played move is the engine's choice the deeper search of the
  // resulting position is the more reliable estimate.
  const scoreBest = playedIsTop ? scoreAfter : scoreTop;
  const winTop = winPercentPov(scoreBest, color);
  const winAfter = winPercentPov(scoreAfter, color);
  const winBest = Math.max(winTop, winAfter);
  const epl = Math.max(0, winBest - winAfter);
  const cpLoss = Math.max(0, clampCp(povCp(scoreBest, color)) - clampCp(povCp(scoreAfter, color)));
  const depth = Math.min(before.terminal ? 999 : before.depth, after.terminal ? 999 : after.depth);
  const provisional = depth < ctx.targetDepth;
  const forced = ctx.legalMoves === 1;
  let facts: { motifs: Motif[]; sacrifice: number; acceptances: { uci: string; gain: number }[] };
  try {
    facts = analyzeMove(ctx.fenBefore, uci);
  } catch {
    facts = { motifs: [], sacrifice: 0, acceptances: [] };
  }
  const motifs = facts.motifs;
  const base = {
    epl, cpLoss, winBest, winAfter, scoreBest, scoreAfter, bestUci, bestPv: top?.pv ?? [], accuracy: moveAccuracy(epl),
    provisional, forced, depth, motifs, sacrifice: facts.sacrifice, acceptances: facts.acceptances.map((a) => a.uci),
    needsSacrificeCheck: false, notes,
  };

  // 1. forced
  if (forced) {
    notes.push('It was the only legal move.');
    return { ...base, cls: 'best', accuracy: 100, provisional: false };
  }
  // 2. book (verified against the opening reference; never for a clear blunder)
  if (ctx.isBook && epl <= THRESHOLDS.mistake) return { ...base, cls: 'book', provisional: false };

  const alternatives = before.lines.filter((l) => l.pv[0] && l.pv[0] !== uci);
  if (ctx.opponentReplies === undefined) {
    try { const c = new Chess(ctx.fenBefore); c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }); ctx = { ...ctx, opponentReplies: c.moves().length }; } catch { /* keep undefined */ }
  }
  const kinds = new Set(motifs.map((m) => m.kind));
  const hadMate = isMateScore(scoreTop) && povCp(scoreTop, color) > 0;
  const keepsMate = isMateScore(scoreAfter) && povCp(scoreAfter, color) > 0;
  // Winning chances are 100% for any forced mate, so "no expected points lost"
  // must not make a slower mate equal to the fastest one.
  const sameAsTop = playedIsTop || kinds.has('checkmate') || before.lines.some((l) => l.pv[0] === uci && sameScore(l.score, scoreTop))
    || (epl <= THRESHOLDS.best && !hadMate);

  // 3. mate handling
  if (hadMate && keepsMate && !sameAsTop && !kinds.has('checkmate')) {
    const a = Math.abs(scoreTop.mate ?? 0);
    const b = Math.abs(scoreAfter.mate ?? 0);
    notes.push(b - a <= 2 ? `Still mates, ${b - a} move${b - a === 1 ? '' : 's'} slower than the fastest mate.` : `Still mates, but a mate ${b - a} moves faster was available.`);
    return { ...base, cls: b - a <= 2 ? 'excellent' : 'good' };
  }
  if (hadMate && !keepsMate && !sameAsTop && winAfter >= 50) {
    const n = Math.abs(scoreTop.mate ?? 0);
    if (epl > THRESHOLDS.good) {
      notes.push(`A forced mate in ${n} was available.`);
      return { ...base, cls: 'miss' };
    }
  }

  // 4. Brilliant: a sound, meaningful piece/exchange sacrifice that is (nearly) best.
  // "Already completely winning" is judged on the best alternative, with mates
  // kept apart from large centipawn scores (both read as ~100% winning chances):
  //  - an alternative that already forces mate: the sacrifice changes nothing;
  //  - an alternative that is merely winning (≥ 90%): only a sacrifice that
  //    turns the position into a forced mate still qualifies.
  if (!provisional && epl <= THRESHOLDS.excellent && facts.sacrifice >= THRESHOLDS.sacrifice) {
    const alt = alternatives[0];
    const winAlt = alt ? winPercentPov(alt.score, color) : winTop;
    const altMates = !!alt && isMateScore(alt.score) && povCp(alt.score, color) > 0;
    const forcesMate = keepsMate;
    const alreadyWinning = altMates || (winAlt >= THRESHOLDS.completelyWinning && !forcesMate);
    const soundAfter = winAfter >= THRESHOLDS.soundAfter;
    if (alreadyWinning) {
      notes.push(altMates ? 'A sacrifice, but a forced mate was available without it.' : 'A sacrifice, but you were already completely winning without it.');
    } else if (soundAfter) {
      const chk = ctx.sacrificeCheck;
      if (chk === undefined) {
        base.needsSacrificeCheck = true;
      } else if (chk && !chk.real) {
        notes.push('The material can be taken, but it comes straight back, so this is not a real sacrifice.');
      } else if (chk) {
        const acceptCost = Math.max(0, chk.acceptWin - winAfter); // what accepting costs the opponent
        const sound = chk.acceptWin >= THRESHOLDS.soundAfter;
        const onlyReply = ctx.opponentReplies === 1;
        const meaningful = acceptCost <= THRESHOLDS.meaningfulAccept || onlyReply;
        if (sound && meaningful) {
          notes.push(`Sacrifices about ${facts.sacrifice} pawns of material. Accepting it (${chk.acceptUci}${onlyReply ? ', the only legal reply' : ''}) still leaves you at ${chk.acceptWin.toFixed(0)}% winning chances, checked at depth ${chk.depth}.`);
          if (forcesMate && winAlt >= THRESHOLDS.completelyWinning) notes.push(`It turns a winning position (${winAlt.toFixed(1)}% with the best alternative) into a forced mate.`);
          return { ...base, cls: 'brilliant' };
        }
        if (sound && !meaningful) notes.push('The offered material cannot be taken safely, so this works as a trap rather than a true sacrifice.');
      }
    }
  }

  // 5. Great: a critical, non-routine best move
  if (sameAsTop && !provisional && alternatives.length > 0 && !kinds.has('checkmate')) {
    const second = winPercentPov(alternatives[0].score, color);
    const gap = winBest - second;
    const recapture = !!ctx.prevUci && ctx.prevUci.slice(2, 4) === uci.slice(2, 4) && (kinds.has('capture') || kinds.has('wins-hanging'));
    const lastMovedTo = ctx.prevUci?.slice(2, 4);
    const routineCapture = kinds.has('wins-hanging') && uci.slice(2, 4) === lastMovedTo && !kinds.has('check') && !kinds.has('fork');
    const routine = recapture || routineCapture || (isMateScore(scoreTop) && Math.abs(scoreTop.mate ?? 0) <= 1);
    const decided = winBest > 97 && second > 90;
    if (!routine && !decided) {
      const onlyMove = gap >= THRESHOLDS.onlyMoveGap && outcomeBand(winBest) > outcomeBand(second);
      const before0 = ctx.moverWinBeforeOpponentMove;
      const turned = before0 !== undefined && (ctx.prevOpponentEpl ?? 0) >= THRESHOLDS.opportunity && gap >= THRESHOLDS.inaccuracy && outcomeBand(winAfter) > outcomeBand(before0);
      if (onlyMove) {
        notes.push(`The only move that keeps the game ${BAND_NAME[outcomeBand(winBest)]}: the next best option leaves it ${BAND_NAME[outcomeBand(second)]} (${gap.toFixed(0)} expected points worse).`);
        return { ...base, cls: 'great' };
      }
      if (turned) {
        notes.push(`Turns a ${BAND_NAME[outcomeBand(before0!)]} game into a ${BAND_NAME[outcomeBand(winAfter)]} one after the opponent's mistake; other moves were ${gap.toFixed(0)} expected points worse.`);
        return { ...base, cls: 'great' };
      }
    }
  }

  // 6. Best
  if (sameAsTop) return { ...base, cls: 'best' };

  // 7. Miss: an opponent mistake created a real chance and the move gave it back
  if (epl > THRESHOLDS.inaccuracy && ctx.prevOpponentEpl !== undefined && ctx.moverWinBeforeOpponentMove !== undefined) {
    const before0 = ctx.moverWinBeforeOpponentMove;
    const opportunity = winBest - before0;
    const realChance = winBest >= 60 || (isMateScore(scoreTop) && povCp(scoreTop, color) > 0);
    const gaveBack = winAfter < before0 + 5;
    const notWorse = winAfter >= before0 - 5;
    if (ctx.prevOpponentEpl >= THRESHOLDS.opportunity && opportunity >= THRESHOLDS.opportunity && realChance && gaveBack && notWorse) {
      notes.push(`The opponent's previous move gave you a chance worth about ${Math.round(opportunity)} expected points that was not taken.`);
      return { ...base, cls: 'miss' };
    }
  }

  // 8. expected-points bands
  return { ...base, cls: bandFor(epl) };
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
