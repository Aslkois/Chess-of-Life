import { Chess } from 'chess.js';
import { gamePhase, parseBoard, pieceCount } from '../analysis/board';
import { analyzeMove } from '../analysis/motifs';
import { materialAlongLine, uciToSan } from '../analysis/explain';
import type { AnalysisResult } from '../engine/controller';
import { winPercentPov } from '../engine/score';
import { rating, type SkillStat } from './skills';

/**
 * "Predict the Opponent" exercise selection. The Coach asks for a prediction
 * only when the opponent's coming move carries real teaching value, respecting
 * a cooldown and the player's history with that kind of moment.
 */
export type PredictionCategory = 'threat' | 'tactic' | 'mate' | 'sacrifice' | 'critical' | 'endgame-transition';

export interface TeachingAssessment {
  score: number;
  category: PredictionCategory | null;
  reasons: string[];
  ask: boolean;
}

export interface PredictionPolicy {
  threshold: number;
  /** minimum plies since the previous exercise */
  cooldownPlies: number;
  /** no exercises before this ply unless the moment is tactical */
  quietOpeningPlies: number;
}

export const DEFAULT_POLICY: PredictionPolicy = { threshold: 4, cooldownPlies: 8, quietOpeningPlies: 16 };

export interface AssessInput {
  /** position with the opponent (Coach) to move */
  fen: string;
  ply: number;
  analysis: AnalysisResult;
  /** UCI of the player's last move */
  lastMoveUci?: string;
  pliesSinceLastExercise: number;
  history: Record<string, SkillStat>;
  enabled: boolean;
  policy?: PredictionPolicy;
}

export function assessTeachingValue(input: AssessInput): TeachingAssessment {
  const policy = input.policy ?? DEFAULT_POLICY;
  const reasons: string[] = [];
  if (!input.enabled) return { score: 0, category: null, reasons: ['exercises disabled'], ask: false };
  const best = input.analysis.bestmove ?? input.analysis.lines[0]?.pv[0];
  if (!best) return { score: 0, category: null, reasons: ['no moves'], ask: false };
  const c = new Chess(input.fen);
  const legal = c.moves().length;
  const side = c.turn();
  let score = 0;
  let category: PredictionCategory | null = null;
  const facts = analyzeMove(input.fen, best);
  const kinds = new Set(facts.motifs.map((m) => m.kind));

  if (legal <= 2) { score -= 5; reasons.push('almost forced'); }
  // obvious recapture
  if (input.lastMoveUci && facts.move.captured && facts.move.to === input.lastMoveUci.slice(2, 4)) { score -= 3; reasons.push('obvious recapture'); }

  if (kinds.has('checkmate') || kinds.has('mate-threat') || kinds.has('back-rank')) { score += 4; category = 'mate'; reasons.push('mating idea'); }
  if (kinds.has('fork') || kinds.has('pin') || kinds.has('skewer') || kinds.has('discovered-attack') || kinds.has('discovered-check')) { score += 3; category ??= 'tactic'; reasons.push('tactical motif'); }
  if (kinds.has('sacrifice')) { score += 2; category ??= 'sacrifice'; reasons.push('sacrifice'); }
  const pv = input.analysis.lines[0]?.pv ?? [];
  const mat = materialAlongLine(input.fen, pv, side);
  if (mat.delta >= 2) { score += 2; category ??= 'threat'; reasons.push(`wins ${mat.delta} pawns of material`); }
  if (kinds.has('wins-hanging')) { score += 1; category ??= 'threat'; reasons.push('punishes a loose piece'); }
  const l1 = input.analysis.lines[0];
  const l2 = input.analysis.lines[1];
  if (l1 && l2) {
    const gap = winPercentPov(l1.score, side) - winPercentPov(l2.score, side);
    if (gap >= 15) { score += 2; category ??= 'critical'; reasons.push('only one good move'); }
  }
  const before = pieceCount(parseBoard(input.fen));
  if (facts.move.captured && before <= 6 && gamePhase(input.fen, input.ply) !== 'opening') { score += 1; category ??= 'endgame-transition'; reasons.push('trade into an endgame'); }

  if (input.ply < policy.quietOpeningPlies && score < policy.threshold + 2) { score -= 3; reasons.push('routine opening phase'); }

  // player history: fewer exercises for well-understood categories
  if (category) {
    const st = input.history[category];
    if (st) {
      const r = rating(st);
      if (r.confidence !== 'none' && r.mean - r.halfWidth >= 0.7) { score -= 2; reasons.push('you usually anticipate this kind of move'); }
      else if (r.confidence !== 'none' && r.mean < 0.4) { score += 1; reasons.push('you often miss this kind of move'); }
    }
  }
  const cooled = input.pliesSinceLastExercise >= policy.cooldownPlies;
  if (!cooled) reasons.push('cooldown');
  return { score, category, reasons, ask: cooled && category !== null && score >= policy.threshold };
}

export type PredictionGrade = 'exact' | 'strong' | 'reasonable' | 'missed' | 'skipped';

export interface PredictionResult {
  grade: PredictionGrade;
  outcome: number;
  predictedSan: string | null;
  actualSan: string | null;
  lesson: string[];
}

/**
 * Grade a prediction fairly: it does not have to match the Coach's move.
 * `predictedWin` is the opponent's (Coach's) winning chance after the predicted
 * move, `bestWin` after its best move, both from the Coach's point of view.
 */
export function gradePrediction(fen: string, predictedUci: string | null, actualUci: string, analysis: AnalysisResult, predictedWin?: number): PredictionResult {
  const c = new Chess(fen);
  const side = c.turn();
  const actualSan = uciToSan(fen, actualUci);
  const lesson: string[] = [];
  try {
    const facts = analyzeMove(fen, actualUci);
    const key = facts.motifs.filter((m) => !['capture', 'castles'].includes(m.kind)).slice(0, 2);
    if (key.length) lesson.push(`${actualSan}: ${key.map((m) => m.text).join(' ')}`);
    const mat = materialAlongLine(fen, analysis.lines.find((l) => l.pv[0] === actualUci)?.pv ?? [actualUci], side);
    if (mat.delta >= 1) lesson.push(`With best play this wins about ${mat.delta} pawn${mat.delta === 1 ? '' : 's'} of material.`);
  } catch { /* ignore */ }
  if (!predictedUci) return { grade: 'skipped', outcome: 0.5, predictedSan: null, actualSan, lesson };
  const predictedSan = uciToSan(fen, predictedUci);
  if (predictedUci === actualUci) return { grade: 'exact', outcome: 1, predictedSan, actualSan, lesson: [`You saw it coming.`, ...lesson] };
  const bestWin = analysis.lines[0] ? winPercentPov(analysis.lines[0].score, side) : 50;
  const inLines = analysis.lines.find((l) => l.pv[0] === predictedUci);
  const pw = inLines ? winPercentPov(inLines.score, side) : predictedWin;
  if (pw === undefined) return { grade: 'missed', outcome: 0, predictedSan, actualSan, lesson };
  const loss = bestWin - pw;
  if (loss < 5) return { grade: 'strong', outcome: 1, predictedSan, actualSan, lesson: [`${predictedSan} is also a strong reply — the opponent had more than one good option.`, ...lesson] };
  if (loss < 12) return { grade: 'reasonable', outcome: 0.5, predictedSan, actualSan, lesson: [`${predictedSan} is playable, but ${actualSan} is more dangerous.`, ...lesson] };
  return { grade: 'missed', outcome: 0, predictedSan, actualSan, lesson: [`${predictedSan} would not trouble you much; the real danger was elsewhere.`, ...lesson] };
}
