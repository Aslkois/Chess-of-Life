import { Chess } from 'chess.js';
import { attacks, kingZone, other, parseBoard, sqIdx } from '../analysis/board';
import { analyzeMove } from '../analysis/motifs';
import { isBookMove } from '../analysis/openings';
import type { EngineController } from '../engine/controller';
import { winPercentPov } from '../engine/score';
import type { Candidate, StrengthProfile } from '../engine/strength';
import { lockedPawnPairs, weaknesses, type RivalModel } from './model';

/**
 * The Rival's competitive strategy. It is derived once, at the start of a
 * Ranked game, from the player model and stored with the match – so the
 * Rival's behaviour is stable and explainable during the game. Strategy only
 * re-orders moves that are already within the level's quality tolerance: it
 * steers the game toward the player's weaknesses with legal, sound chess.
 */
export interface RivalStrategy {
  kingAttack: number;
  closeStructure: number;
  openStructure: number;
  simplify: number;
  complicate: number;
  sacrifice: number;
  /** extra complication when the player is short of time */
  timePressure: number;
  /** opening lines (UCI from the start) the Rival wants to steer toward */
  openingLines: { line: string[]; name: string; weight: number }[];
  /** opening lines to avoid (player scores well) */
  avoidLines: { line: string[]; name: string }[];
  notes: string[];
}

export const NEUTRAL_STRATEGY: RivalStrategy = { kingAttack: 0, closeStructure: 0, openStructure: 0, simplify: 0, complicate: 0, sacrifice: 0, timePressure: 0, openingLines: [], avoidLines: [], notes: [] };

const cap = (x: number) => Math.max(0, Math.min(1.5, x));

export function deriveStrategy(model: RivalModel, rivalColor: 'w' | 'b'): RivalStrategy {
  const s: RivalStrategy = structuredClone(NEUTRAL_STRATEGY);
  const conf = (c: string) => (c === 'good' ? 1 : c === 'moderate' ? 0.75 : 0.45);
  for (const w of weaknesses(model)) {
    const k = w.strength * 4 * conf(w.confidence);
    switch (w.id) {
      case 'king-safety': s.kingAttack = cap(s.kingAttack + k); s.notes.push(`Pursue king attacks when sound (${w.evidence}).`); break;
      case 'defense': s.kingAttack = cap(s.kingAttack + k / 2); s.complicate = cap(s.complicate + k / 2); s.notes.push(`Keep pressure on when you are worse (${w.evidence}).`); break;
      case 'closed': s.closeStructure = cap(k); s.notes.push(`Favour closed pawn structures (${w.evidence}).`); break;
      case 'open': s.openStructure = cap(k); s.notes.push(`Favour open positions (${w.evidence}).`); break;
      case 'endgame': s.simplify = cap(s.simplify + k); s.notes.push(`Trade pieces toward endgames when equal or better (${w.evidence}).`); break;
      case 'tactics': case 'patterns': case 'anticipation': case 'hanging':
        s.complicate = cap(s.complicate + k / 2); if (!s.notes.some((n) => n.startsWith('Keep tactical'))) s.notes.push(`Keep tactical tension (${w.label}: ${w.evidence}).`); break;
      case 'vs-sacrifice': s.sacrifice = cap(k); s.notes.push(`Sound sacrifices are worth offering (${w.evidence}).`); break;
      case 'time-pressure': s.timePressure = cap(k); s.notes.push(`Complicate when your clock is low (${w.evidence}).`); break;
      case 'conversion': s.complicate = cap(s.complicate + k / 3); s.notes.push(`Defend stubbornly in worse positions (${w.evidence}).`); break;
      default: break;
    }
  }
  const playerColor = other(rivalColor);
  for (const rec of Object.values(model.openings)) {
    if (rec.playerColor !== playerColor || rec.games < 1 || !rec.line.length) continue;
    const avg = rec.score / rec.games;
    const epl = rec.moves ? rec.eplSum / rec.moves : 0;
    if (avg <= 0.5 || epl >= 6) {
      s.openingLines.push({ line: rec.line, name: rec.name, weight: cap((0.6 - avg) * 2 + epl / 10 + 0.3) });
    } else if (avg >= 0.75 && rec.games >= 2) {
      s.avoidLines.push({ line: rec.line, name: rec.name });
    }
  }
  s.openingLines.sort((a, b) => b.weight - a.weight);
  if (s.openingLines.length) s.notes.push(`Steer toward openings where you have struggled: ${s.openingLines.slice(0, 2).map((o) => o.name).join(', ')}.`);
  if (s.avoidLines.length) s.notes.push(`Avoid openings where you score well: ${s.avoidLines.slice(0, 2).map((o) => o.name).join(', ')}.`);
  return s;
}

export interface ShapeContext {
  fen: string;
  /** UCI moves played from the start position */
  history: string[];
  rivalColor: 'w' | 'b';
  playerClockFraction?: number;
}

/** Score candidates for the strategy; returns candidates with bonus and reasons set. */
export function applyStrategy(cands: Candidate[], strat: RivalStrategy, ctx: ShapeContext): Candidate[] {
  const board = parseBoard(ctx.fen);
  const opp = other(ctx.rivalColor);
  const zone = new Set(kingZone(board, opp));
  const lockedBefore = lockedPawnPairs(board);
  const ply = ctx.history.length;
  return cands.map((c) => {
    let bonus = 0;
    const reasons: string[] = [];
    let facts;
    try { facts = analyzeMove(ctx.fen, c.uci); } catch { return c; }
    const after = parseBoard(facts.fenAfter);
    const kinds = new Set(facts.motifs.map((m) => m.kind));
    // opening steering
    for (const ol of strat.openingLines) {
      if (ol.line.length > ply && ctx.history.every((u, i) => ol.line[i] === u) && ol.line[ply] === c.uci) {
        bonus += ol.weight; reasons.push(`opening plan: ${ol.name}`); break;
      }
    }
    for (const al of strat.avoidLines) {
      if (al.line.length > ply && ctx.history.every((u, i) => al.line[i] === u) && al.line[ply] === c.uci) { bonus -= 0.6; reasons.push(`avoid ${al.name}`); break; }
    }
    if (strat.kingAttack > 0) {
      const to = sqIdx(c.uci.slice(2, 4));
      const hits = attacks(after, to).filter((s) => zone.has(s)).length;
      if (kinds.has('check') || kinds.has('discovered-check') || kinds.has('mate-threat') || hits >= 2) { bonus += strat.kingAttack; reasons.push('king attack'); }
    }
    const lockedAfter = lockedPawnPairs(after);
    if (strat.closeStructure > 0 && lockedAfter > lockedBefore) { bonus += strat.closeStructure; reasons.push('closes the structure'); }
    if (strat.openStructure > 0 && lockedAfter < lockedBefore) { bonus += strat.openStructure; reasons.push('opens the position'); }
    const trade = !!facts.move.captured && facts.sacrifice === 0 && facts.exposedLoss === 0;
    if (strat.simplify > 0 && trade && c.win >= 50) { bonus += strat.simplify; reasons.push('simplifies'); }
    const tactical = ['fork', 'pin', 'skewer', 'discovered-attack', 'mate-threat', 'sacrifice'].some((k) => kinds.has(k as never));
    if (strat.complicate > 0 && (tactical || (!facts.move.captured && c.win >= 40))) { bonus += strat.complicate * (tactical ? 1 : 0.3); reasons.push('keeps tension'); }
    if (strat.sacrifice > 0 && kinds.has('sacrifice') && c.win >= 50) { bonus += strat.sacrifice; reasons.push('sound sacrifice'); }
    if (strat.timePressure > 0 && (ctx.playerClockFraction ?? 1) < 0.15 && (tactical || facts.move.san.includes('+'))) { bonus += strat.timePressure; reasons.push('opponent short of time'); }
    return { ...c, bonus: c.bonus + bonus, reasons: [...c.reasons, ...reasons] };
  });
}

/**
 * Add the next move of a targeted opening line to the candidate list when the
 * engine did not list it, provided it is a catalogued book move and its
 * evaluation is within the level's tolerance (verified by a restricted search).
 */
export async function withOpeningCandidates(
  engine: EngineController, cands: Candidate[], strat: RivalStrategy, ctx: ShapeContext, profile: StrengthProfile, signal?: AbortSignal,
): Promise<Candidate[]> {
  const ply = ctx.history.length;
  const wanted = new Set<string>();
  for (const ol of strat.openingLines) {
    if (ol.line.length > ply && ctx.history.every((u, i) => ol.line[i] === u)) wanted.add(ol.line[ply]);
  }
  const out = [...cands];
  const best = cands[0];
  for (const uci of wanted) {
    if (out.some((c) => c.uci === uci) || !isBookMove(ctx.fen, uci) || !best) continue;
    const chess = new Chess(ctx.fen);
    let san: string;
    try { san = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { continue; }
    const r = await engine.analyze({ fen: ctx.fen, depth: profile.depth, multipv: 1, searchmoves: [uci], priority: 2, signal });
    const line = r.lines[0];
    if (!line) continue;
    const win = winPercentPov(line.score, ctx.rivalColor);
    const epl = Math.max(0, best.win - win);
    if (epl <= Math.max(profile.tolerance, 4)) out.push({ uci, san, epl, win, pv: line.pv, bonus: 0, reasons: ['book move'] });
  }
  return out;
}
