/**
 * Skill categories and evidence tagging. Shared vocabulary for the Coach's
 * learning profile and the Rival's player model; each keeps its own data.
 */
import { gamePhase, parseBoard } from '../analysis/board';
import { analyzeMove } from '../analysis/motifs';

export type Skill =
  | 'opening' | 'tactics' | 'patterns' | 'hanging' | 'king-safety' | 'defense'
  | 'positional' | 'pawns' | 'endgame' | 'anticipation' | 'conversion' | 'recurring';

export const SKILLS: { id: Skill; label: string; desc: string }[] = [
  { id: 'opening', label: 'Opening principles', desc: 'Move quality in the first 10 moves.' },
  { id: 'tactics', label: 'Tactical calculation', desc: 'Finding the strongest move when a forcing tactic exists.' },
  { id: 'patterns', label: 'Pattern recognition', desc: 'Forks, pins, skewers and discovered attacks.' },
  { id: 'hanging', label: 'Hanging pieces', desc: 'Keeping pieces protected and noticing loose ones.' },
  { id: 'king-safety', label: 'King safety', desc: 'Avoiding weaknesses and mating threats around your king.' },
  { id: 'defense', label: 'Defensive play', desc: 'Move quality when you are worse.' },
  { id: 'positional', label: 'Positional understanding', desc: 'Quiet positions without immediate tactics.' },
  { id: 'pawns', label: 'Pawn structures', desc: 'Quality of pawn moves and passed-pawn play.' },
  { id: 'endgame', label: 'Endgames', desc: 'Move quality once most pieces are traded.' },
  { id: 'anticipation', label: "Calculating opponent's replies", desc: 'Predicting and preventing your opponent’s best responses.' },
  { id: 'conversion', label: 'Converting advantages', desc: 'Keeping winning positions winning.' },
  { id: 'recurring', label: 'Avoiding repeated mistakes', desc: 'Not repeating the same kind of error.' },
];

const TACTICAL = new Set(['fork', 'pin', 'skewer', 'discovered-attack', 'discovered-check', 'wins-hanging', 'checkmate', 'mate-threat', 'back-rank', 'sacrifice', 'overloaded-defender']);
const PATTERN = new Set(['fork', 'pin', 'skewer', 'discovered-attack', 'discovered-check']);

export interface MoveEvidence {
  fenBefore: string;
  uci: string;
  bestUci: string | null;
  epl: number;
  ply: number;
  /** mover POV win% with best play before the move */
  winBest: number;
  /** opponent's best reply after the played move (UCI), if known */
  replyUci?: string;
}

/** Which skills a decision provides evidence about. */
export function tagSkills(e: MoveEvidence): Skill[] {
  const tags = new Set<Skill>();
  const phase = gamePhase(e.fenBefore, e.ply);
  if (phase === 'opening' && e.ply <= 20) tags.add('opening');
  if (phase === 'endgame') tags.add('endgame');
  let bestKinds: string[] = [];
  let playedKinds: string[] = [];
  let fenAfter = '';
  try {
    if (e.bestUci) bestKinds = analyzeMove(e.fenBefore, e.bestUci).motifs.map((m) => m.kind);
    const pf = analyzeMove(e.fenBefore, e.uci);
    playedKinds = pf.motifs.map((m) => m.kind);
    fenAfter = pf.fenAfter;
  } catch { /* ignore */ }
  if (bestKinds.some((k) => TACTICAL.has(k))) tags.add('tactics');
  if (bestKinds.some((k) => PATTERN.has(k)) || playedKinds.some((k) => PATTERN.has(k))) tags.add('patterns');
  if (playedKinds.some((k) => k === 'hanging-left' || k === 'defender-removed' || k === 'threat-ignored')) tags.add('hanging');
  if (playedKinds.includes('king-exposure')) tags.add('king-safety');
  if (e.replyUci && fenAfter) {
    try {
      const r = analyzeMove(fenAfter, e.replyUci).motifs.map((m) => m.kind);
      if (r.some((k) => k === 'checkmate' || k === 'mate-threat' || k === 'back-rank')) tags.add('king-safety');
      if (e.epl >= 10 && r.some((k) => TACTICAL.has(k))) tags.add('anticipation');
      if (r.includes('wins-hanging') && e.epl >= 10) tags.add('hanging');
    } catch { /* ignore */ }
  }
  if (e.winBest < 35) tags.add('defense');
  if (e.winBest >= 75) tags.add('conversion');
  if (!bestKinds.some((k) => TACTICAL.has(k)) && phase !== 'opening') tags.add('positional');
  const b = parseBoard(e.fenBefore);
  const from = (e.uci.charCodeAt(0) - 97) + (parseInt(e.uci[1], 10) - 1) * 8;
  if (b[from]?.t === 'p' || playedKinds.includes('passed-pawn')) tags.add('pawns');
  return [...tags];
}

/**
 * Does this decision say anything about skill? In a position that is already
 * decided (the mover's best winning chance is below 3 %, or above 97 % and
 * the move kept it) no move can lose meaningful expected points, so it is
 * not counted as evidence either way.
 */
export function isInformative(winBest: number, epl: number): boolean {
  if (winBest < 3) return false;
  if (winBest > 97 && epl < 5) return false;
  return true;
}

/** Outcome score of a decision: 1 = success, 0 = failure, 0.5 = partial. */
export function outcomeOf(epl: number): number {
  if (epl < 5) return 1;
  if (epl < 10) return 0.5;
  return 0;
}

export interface SkillStat {
  /** Beta posterior pseudo-counts (prior 1,1) */
  s: number;
  f: number;
  n: number;
  /** recent outcomes, newest last (max 30) */
  recent: number[];
}

export const emptyStat = (): SkillStat => ({ s: 0, f: 0, n: 0, recent: [] });

export function addOutcome(st: SkillStat, outcome: number): SkillStat {
  return { s: st.s + outcome, f: st.f + (1 - outcome), n: st.n + 1, recent: [...st.recent, outcome].slice(-30) };
}

export type Confidence = 'none' | 'low' | 'moderate' | 'good';

export function confidenceOf(n: number): Confidence {
  if (n < 5) return 'none';
  if (n < 15) return 'low';
  if (n < 40) return 'moderate';
  return 'good';
}

/** Posterior mean success rate with a uniform prior, and a 90% interval half-width. */
export function rating(st: SkillStat): { mean: number; halfWidth: number; confidence: Confidence; trend: number | null } {
  const a = st.s + 1;
  const b = st.f + 1;
  const mean = a / (a + b);
  const v = (a * b) / ((a + b) ** 2 * (a + b + 1));
  const halfWidth = 1.645 * Math.sqrt(v);
  let trend: number | null = null;
  if (st.recent.length >= 12) {
    const half = Math.floor(st.recent.length / 2);
    const older = st.recent.slice(0, half);
    const newer = st.recent.slice(half);
    trend = newer.reduce((x, y) => x + y, 0) / newer.length - older.reduce((x, y) => x + y, 0) / older.length;
  }
  return { mean, halfWidth, confidence: confidenceOf(st.n), trend };
}
