import { Chess } from 'chess.js';
import { mainline, type GameTree } from '../chess/tree';
import { AbortedError, type AnalysisResult, type EngineController } from '../engine/controller';
import { winPercent, type Score } from '../engine/score';
import { gameAccuracy, classifyMove, CLASS_ORDER, type Classification, type MoveClassification, type SacrificeCheck } from './classify';
import { verifySacrifice } from './verify';
import { explainForReview, pvToSan, uciToSan } from './explain';
import { identifyOpening, type OpeningInfo } from './openings';
import { gamePhase, type Phase } from './board';
import { analyzeMove } from './motifs';

export interface MoveReview {
  nodeId: string;
  ply: number;
  color: 'w' | 'b';
  san: string;
  uci: string;
  cls: Classification;
  epl: number;
  cpLoss: number;
  /** mover POV */
  winBefore: number;
  winAfter: number;
  evalBefore: Score;
  evalAfter: Score;
  bestUci: string | null;
  bestSan: string | null;
  bestLine: string[];
  accuracy: number;
  provisional: boolean;
  forced: boolean;
  depth: number;
  phase: Phase;
  motifKinds: string[];
  explanation: string[];
  sacrifice: number;
}

export interface PositionEval {
  nodeId: string;
  fen: string;
  score: Score;
  depth: number;
  lines: { score: Score; pv: string[] }[];
}

export interface GameReview {
  gameId: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  quickDepth: number;
  deepDepth: number;
  status: 'running' | 'quick' | 'complete' | 'cancelled' | 'error';
  progress: { done: number; total: number; pass: 'quick' | 'deep' };
  positions: PositionEval[];
  moves: MoveReview[];
  accuracy: { w: number | null; b: number | null };
  counts: { w: Record<Classification, number>; b: Record<Classification, number> };
  opening: OpeningInfo | null;
  bookPlies: number;
  turningPoints: number[];
  summary: string[];
  error?: string;
}

/**
 * Bump when classification rules change: stored reviews with an older version
 * are re-run (cheap, because engine results are cached per position). Games,
 * branches and profiles are never touched by this.
 */
export const REVIEW_VERSION = 2;

export interface ReviewOptions {
  quickDepth?: number;
  deepDepth?: number;
  multipv?: number;
  signal?: AbortSignal;
  onUpdate?: (r: GameReview) => void;
  /** skip the deep pass */
  quickOnly?: boolean;
}

const emptyCounts = () => Object.fromEntries(CLASS_ORDER.map((c) => [c, 0])) as Record<Classification, number>;

/**
 * Full game review: a fast pass over every position (provisional results),
 * then a deeper pass that refines each classification. Every position is
 * analysed once (MultiPV) and the position after move N doubles as the
 * position before move N+1.
 */
export async function reviewGame(engine: EngineController, gameId: string, tree: GameTree, opts: ReviewOptions = {}): Promise<GameReview> {
  const quickDepth = opts.quickDepth ?? 10;
  const deepDepth = opts.deepDepth ?? 16;
  const multipv = opts.multipv ?? 3;
  const line = mainline(tree);
  const nodes = line.map((id) => tree.nodes[id]);
  const fens = nodes.map((n) => n.fen);
  const ucis = nodes.slice(1).map((n) => n.uci!);
  const { opening, bookPlies } = identifyOpening(fens, ucis);
  const review: GameReview = {
    gameId, version: REVIEW_VERSION, createdAt: Date.now(), updatedAt: Date.now(), quickDepth, deepDepth,
    status: 'running', progress: { done: 0, total: fens.length * (opts.quickOnly ? 1 : 2), pass: 'quick' },
    positions: [], moves: [], accuracy: { w: null, b: null }, counts: { w: emptyCounts(), b: emptyCounts() },
    opening, bookPlies, turningPoints: [], summary: [],
  };
  const results: (AnalysisResult | undefined)[] = new Array(fens.length);
  const sacrificeChecks = new Map<number, SacrificeCheck | null>();

  const runPass = async (depth: number, pass: 'quick' | 'deep') => {
    review.progress.pass = pass;
    for (let i = 0; i < fens.length; i++) {
      if (opts.signal?.aborted) throw new AbortedError();
      const prev = results[i];
      if (!prev || prev.depth < depth) {
        results[i] = await engine.analyze({ fen: fens[i], depth, multipv, priority: 0, signal: opts.signal });
      }
      review.progress.done++;
      // classify move i (from position i-1 to i) as soon as both sides are known
      if (i >= 1) await rebuildMove(i - 1, depth);
      if (i % 4 === 0 || i === fens.length - 1) emit();
    }
  };

  const rebuildMove = async (m: number, targetDepth: number, cascade = true): Promise<void> => {
    const before = results[m];
    const after = results[m + 1];
    if (!before || !after) return;
    const color: 'w' | 'b' = new Chess(fens[m]).turn();
    const prevMove = m >= 1 ? review.moves[m - 1] : undefined;
    const ctx = {
      fenBefore: fens[m],
      uci: ucis[m],
      color,
      before,
      after,
      prevOpponentEpl: prevMove?.epl,
      moverWinBeforeOpponentMove: prevMove ? 100 - prevMove.winBefore : undefined,
      prevUci: m >= 1 ? ucis[m - 1] : undefined,
      isBook: m < bookPlies,
      legalMoves: new Chess(fens[m]).moves().length,
      targetDepth: deepDepth,
      sacrificeCheck: sacrificeChecks.get(m),
    };
    let c: MoveClassification = classifyMove(ctx);
    if (c.needsSacrificeCheck && !opts.signal?.aborted) {
      // Tactical verification: the opponent's best acceptance, at the final depth.
      try {
        const chk = await verifySacrifice(engine, fens[m], ucis[m], c.acceptances, color, deepDepth, 0, opts.signal);
        sacrificeChecks.set(m, chk);
        c = classifyMove({ ...ctx, sacrificeCheck: chk });
      } catch (e) {
        if (e instanceof AbortedError) throw e;
      }
    }
    const node = nodes[m + 1];
    review.moves[m] = {
      nodeId: node.id,
      ply: node.ply,
      color,
      san: node.san!,
      uci: ucis[m],
      cls: c.cls,
      epl: c.epl,
      cpLoss: c.cpLoss,
      winBefore: c.winBest,
      winAfter: c.winAfter,
      evalBefore: before.lines[0]?.score ?? { cp: 0 },
      evalAfter: c.scoreAfter,
      bestUci: c.bestUci,
      bestSan: uciToSan(fens[m], c.bestUci),
      bestLine: pvToSan(fens[m], c.bestPv, 10),
      accuracy: c.accuracy,
      provisional: c.provisional,
      forced: c.forced,
      depth: c.depth,
      phase: gamePhase(fens[m], node.ply),
      motifKinds: c.motifs.map((x) => x.kind),
      explanation: explainForReview(fens[m], ucis[m], color, c, c.cls, after.lines[0]?.pv ?? []),
      sacrifice: c.sacrifice,
    };
    // a deeper evaluation of this move changes the "opportunity" context of the next move
    if (cascade && m + 1 < ucis.length && review.moves[m + 1] && results[m + 2]) await rebuildMove(m + 1, targetDepth, false);
  };

  const emit = () => {
    review.positions = results.map((r, i) => ({
      nodeId: nodes[i].id,
      fen: fens[i],
      score: r?.lines[0]?.score ?? { cp: 0 },
      depth: r?.depth ?? 0,
      lines: (r?.lines ?? []).map((l) => ({ score: l.score, pv: l.pv })),
    }));
    finalize(review);
    review.updatedAt = Date.now();
    opts.onUpdate?.(structuredClone(review));
  };

  try {
    await runPass(quickDepth, 'quick');
    review.status = 'quick';
    emit();
    if (!opts.quickOnly) {
      await runPass(deepDepth, 'deep');
    }
    review.status = 'complete';
    emit();
  } catch (e) {
    review.status = e instanceof AbortedError ? 'cancelled' : 'error';
    if (!(e instanceof AbortedError)) review.error = String(e instanceof Error ? e.message : e);
    emit();
  }
  return review;
}

export function finalize(review: GameReview) {
  const moves = review.moves.filter(Boolean);
  review.counts = { w: emptyCounts(), b: emptyCounts() };
  for (const m of moves) review.counts[m.color][m.cls]++;
  const winsWhite = review.positions.map((p) => winPercent(p.score));
  const acc = moves.map((m) => m.accuracy);
  const counted = (color: 'w' | 'b') => moves.map((m) => m.color === color && !m.forced);
  review.accuracy = {
    w: moves.length ? gameAccuracy(acc, winsWhite, counted('w')) : null,
    b: moves.length ? gameAccuracy(acc, winsWhite, counted('b')) : null,
  };
  // turning points: largest swings in White's winning chances caused by errors
  const swings = moves
    .map((m, i) => ({ i, swing: Math.abs((winsWhite[i + 1] ?? 50) - (winsWhite[i] ?? 50)), m }))
    .filter((x) => x.swing >= 15 && ['inaccuracy', 'mistake', 'miss', 'blunder', 'brilliant', 'great'].includes(x.m.cls))
    .sort((a, b) => b.swing - a.swing)
    .slice(0, 5)
    .map((x) => x.i)
    .sort((a, b) => a - b);
  review.turningPoints = swings;
  review.summary = summarize(review, moves);
}

function summarize(review: GameReview, moves: MoveReview[]): string[] {
  const out: string[] = [];
  if (!moves.length) return ['No moves to review.'];
  if (review.opening) out.push(`Opening: ${review.opening.name} (${review.opening.eco}), in book for ${review.bookPlies} plies.`);
  else out.push('The opening could not be matched to the opening reference.');
  const side = (c: 'w' | 'b') => (c === 'w' ? 'White' : 'Black');
  for (const c of ['w', 'b'] as const) {
    const a = review.accuracy[c];
    const k = review.counts[c];
    const errs = k.blunder + k.mistake + k.miss;
    out.push(`${side(c)}: accuracy ${a === null ? '—' : a.toFixed(1)}%, ${k.brilliant + k.great} brilliant/great, ${k.best + k.excellent} best/excellent, ${k.inaccuracy} inaccuracies, ${errs} serious errors (mistakes, misses, blunders).`);
  }
  const worst = [...moves].sort((a, b) => b.epl - a.epl)[0];
  if (worst && worst.epl >= 10) {
    out.push(`Costliest decision: ${Math.ceil(worst.ply / 2)}${worst.color === 'w' ? '.' : '...'} ${worst.san} (${side(worst.color)}, ${worst.cls}) — ${worst.bestSan ? `${worst.bestSan} was stronger` : 'the position changed hands'}; it cost about ${worst.epl.toFixed(0)} expected points.`);
  }
  const shine = moves.filter((m) => m.cls === 'brilliant' || m.cls === 'great');
  if (shine.length) out.push(`Strongest decisions: ${shine.slice(0, 3).map((m) => `${Math.ceil(m.ply / 2)}${m.color === 'w' ? '.' : '...'} ${m.san} (${m.cls})`).join(', ')}.`);
  const byPhase: Record<string, number[]> = {};
  for (const m of moves) (byPhase[m.phase] ??= []).push(m.epl);
  const phases = Object.entries(byPhase).map(([p, e]) => `${p} ${(e.reduce((a, b) => a + b, 0) / e.length).toFixed(1)}`);
  out.push(`Average expected points lost per move by phase: ${phases.join(', ')}.`);
  if (review.turningPoints.length) {
    out.push(`Turning points: ${review.turningPoints.map((i) => `${Math.ceil(moves[i].ply / 2)}${moves[i].color === 'w' ? '.' : '...'} ${moves[i].san}`).join(', ')}.`);
  }
  const prov = moves.filter((m) => m.provisional).length;
  if (prov) out.push(`${prov} classification${prov === 1 ? ' is' : 's are'} provisional (deeper analysis pending).`);
  return out;
}

export { analyzeMove };
