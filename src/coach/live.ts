import { Chess } from 'chess.js';
import { classifyMove, type MoveClassification } from '../analysis/classify';
import { identifyOpening } from '../analysis/openings';
import type { AnalysisResult, EngineController } from '../engine/controller';
import { winPercentPov } from '../engine/score';

/**
 * Live move classification used by the Coach (and nothing else): a light
 * search for immediate feedback, then a deeper one that replaces it.
 */
export interface LiveContext {
  fens: string[];
  ucis: string[];
  /** index of the move being classified (fens[index] is the position before it) */
  index: number;
  uci: string;
  prevEpl?: number;
  /** mover's win% before the opponent's previous move */
  moverWinBefore?: number;
}

export async function classifyLive(engine: EngineController, ctx: LiveContext, depth: number, targetDepth: number, priority: 0 | 1 | 2, signal?: AbortSignal): Promise<{ c: MoveClassification; before: AnalysisResult; after: AnalysisResult }> {
  const fenBefore = ctx.fens[ctx.index];
  const c = new Chess(fenBefore);
  const color = c.turn();
  const mv = c.move({ from: ctx.uci.slice(0, 2), to: ctx.uci.slice(2, 4), promotion: ctx.uci[4] });
  const fenAfter = c.fen();
  const before = await engine.analyze({ fen: fenBefore, depth, multipv: 3, priority, signal });
  const after = await engine.analyze({ fen: fenAfter, depth, multipv: 1, priority, signal });
  const book = identifyOpening([...ctx.fens.slice(0, ctx.index + 1), fenAfter], [...ctx.ucis.slice(0, ctx.index), ctx.uci]);
  const base = {
    fenBefore, uci: ctx.uci, color, before, after, prevOpponentEpl: ctx.prevEpl, moverWinBeforeOpponentMove: ctx.moverWinBefore,
    prevUci: ctx.index > 0 ? ctx.ucis[ctx.index - 1] : undefined, isBook: book.bookPlies === ctx.index + 1,
    legalMoves: new Chess(fenBefore).moves().length, targetDepth,
  };
  let cls = classifyMove(base);
  if (cls.needsSacrificeCheck) {
    // verify the sacrifice: opponent accepts with the best capture on the destination square
    const acc = new Chess(fenAfter);
    const caps = acc.moves({ verbose: true }).filter((m) => m.captured && m.to === mv.to);
    if (caps.length) {
      acc.move(caps[0]);
      const r = await engine.analyze({ fen: acc.fen(), depth: Math.max(8, depth - 2), multipv: 1, priority, signal });
      cls = classifyMove({ ...base, sacrificeAcceptedWin: r.lines[0] ? winPercentPov(r.lines[0].score, color) : 0 });
    } else cls = classifyMove({ ...base, sacrificeAcceptedWin: 0 });
  }
  return { c: cls, before, after };
}
