import { Chess } from 'chess.js';
import { classifyMove, type MoveClassification } from '../analysis/classify';
import { identifyOpening } from '../analysis/openings';
import { verifySacrifice } from '../analysis/verify';
import type { AnalysisResult, EngineController } from '../engine/controller';

/**
 * Live move classification used by the Coach: a light search for immediate
 * feedback (provisional, never Brilliant/Great), then a deeper one that
 * replaces it and may verify a sacrifice.
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

export async function classifyLive(engine: EngineController, ctx: LiveContext, depth: number, targetDepth: number, priority: 0 | 1 | 2, signal?: AbortSignal): Promise<{ c: MoveClassification; before: AnalysisResult; after: AnalysisResult; fenAfter: string }> {
  const fenBefore = ctx.fens[ctx.index];
  const c = new Chess(fenBefore);
  const color = c.turn();
  c.move({ from: ctx.uci.slice(0, 2), to: ctx.uci.slice(2, 4), promotion: ctx.uci[4] });
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
    const chk = await verifySacrifice(engine, fenBefore, ctx.uci, cls.acceptances, color, targetDepth, priority, signal);
    cls = classifyMove({ ...base, sacrificeCheck: chk });
  }
  return { c: cls, before, after, fenAfter };
}
