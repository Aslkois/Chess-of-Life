import { Chess } from 'chess.js';
import type { EngineController, Priority } from '../engine/controller';
import { isMateScore, povCp, winPercentPov } from '../engine/score';
import { materialBalance, parseBoard } from './board';
import type { SacrificeCheck } from './classify';

/**
 * Material for `mover` (pawns, relative to `fenBefore`) after playing `line`
 * from `fenBefore`, sampled after `plies` moves. Returns null if the line is
 * shorter (or illegal).
 */
function deficitAfter(fenBefore: string, line: string[], mover: 'w' | 'b', plies: number): number | null {
  const c = new Chess(fenBefore);
  const start = materialBalance(parseBoard(fenBefore));
  let n = 0;
  for (const u of line) {
    try { c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { return null; }
    if (++n === plies) break;
  }
  if (n < plies && !c.isCheckmate()) return null;
  const d = materialBalance(parseBoard(c.fen())) - start;
  return mover === 'w' ? d : -d;
}

/**
 * Verify a sacrifice with the engine. Among the opponent's legal captures that
 * would win the offered material, search each one (restricted MultiPV) at the
 * final depth. An acceptance counts as *real* only if the mover is still down
 * at least two pawns after the capture and the mover's reply (material not
 * simply taken back elsewhere) or the line ends in mate. The check reports the
 * real acceptance that is best for the opponent.
 */
export async function verifySacrifice(
  engine: EngineController, fenBefore: string, playedUci: string, acceptances: string[], mover: 'w' | 'b', depth: number, priority: Priority, signal?: AbortSignal,
): Promise<SacrificeCheck | null> {
  const c = new Chess(fenBefore);
  c.move({ from: playedUci.slice(0, 2), to: playedUci.slice(2, 4), promotion: playedUci[4] });
  const fenAfter = c.fen();
  const legal = new Set(c.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? '')));
  const moves = acceptances.filter((u) => legal.has(u)).slice(0, 4);
  if (!moves.length) return null;
  const r = await engine.analyze({ fen: fenAfter, depth, multipv: moves.length, searchmoves: moves, priority, signal });
  let best: { uci: string; win: number } | null = null;
  for (const l of r.lines) {
    if (!l.pv[0] || !moves.includes(l.pv[0])) continue;
    const mates = isMateScore(l.score) && povCp(l.score, mover) > 0;
    const d = deficitAfter(fenBefore, [playedUci, ...l.pv], mover, 3);
    const real = mates || (d !== null && d <= -2);
    if (!real) continue;
    const win = winPercentPov(l.score, mover);
    if (!best || win < best.win) best = { uci: l.pv[0], win };
  }
  if (!best) return { acceptUci: '', acceptWin: 0, depth: r.depth, real: false };
  let san = best.uci;
  try { san = new Chess(fenAfter).move({ from: san.slice(0, 2), to: san.slice(2, 4), promotion: san[4] }).san; } catch { /* keep uci */ }
  return { acceptUci: san, acceptWin: best.win, depth: r.depth, real: true };
}
