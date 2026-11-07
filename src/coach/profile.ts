import { addOutcome, emptyStat, rating, SKILLS, type Skill, type SkillStat } from './skills';

/**
 * The Coach's learning profile. Independent decisions (first attempts made
 * without hints) are kept apart from assisted ones (after a takeback or a
 * hint) so that corrections never inflate the measure of real skill.
 */
export interface LearningProfile {
  id: 'coach';
  version: 1;
  independent: Record<Skill, SkillStat>;
  assisted: Record<Skill, SkillStat>;
  /** prediction exercise results by motif category */
  predictions: Record<string, SkillStat>;
  /** counts of error motifs (for "recurring mistakes") */
  errorMotifs: Record<string, number>;
  games: number;
  movesIndependent: number;
  movesAssisted: number;
  hintsUsed: number;
  takebacks: number;
  /** recent independent per-game accuracy values */
  accuracyHistory: { ts: number; accuracy: number }[];
  /** coach strength level 1..20 used for the next game */
  coachLevel: number;
  updatedAt: number;
}

export function emptyProfile(): LearningProfile {
  const mk = () => Object.fromEntries(SKILLS.map((s) => [s.id, emptyStat()])) as Record<Skill, SkillStat>;
  return {
    id: 'coach', version: 1, independent: mk(), assisted: mk(), predictions: {}, errorMotifs: {}, games: 0,
    movesIndependent: 0, movesAssisted: 0, hintsUsed: 0, takebacks: 0, accuracyHistory: [], coachLevel: 6, updatedAt: Date.now(),
  };
}

export interface DecisionRecord {
  skills: Skill[];
  outcome: number;
  independent: boolean;
  errorMotifs?: string[];
}

export function recordDecision(p: LearningProfile, d: DecisionRecord): LearningProfile {
  const bucket = d.independent ? 'independent' : 'assisted';
  const next = { ...p, [bucket]: { ...p[bucket] } } as LearningProfile;
  for (const s of d.skills) next[bucket][s] = addOutcome(next[bucket][s] ?? emptyStat(), d.outcome);
  if (d.independent) next.movesIndependent++;
  else next.movesAssisted++;
  if (d.outcome === 0 && d.errorMotifs?.length && d.independent) {
    next.errorMotifs = { ...p.errorMotifs };
    let repeated = false;
    for (const m of d.errorMotifs) {
      next.errorMotifs[m] = (next.errorMotifs[m] ?? 0) + 1;
      if (next.errorMotifs[m] >= 2) repeated = true;
    }
    next.independent.recurring = addOutcome(next.independent.recurring, repeated ? 0 : 1);
  } else if (d.independent && d.outcome === 1) {
    // a clean decision is (weak) evidence of not repeating mistakes
    if (Object.keys(p.errorMotifs).length) next.independent.recurring = addOutcome(next.independent.recurring, 1);
  }
  next.updatedAt = Date.now();
  return next;
}

export function recordPrediction(p: LearningProfile, category: string, outcome: number): LearningProfile {
  const predictions = { ...p.predictions, [category]: addOutcome(p.predictions[category] ?? emptyStat(), outcome) };
  const independent = { ...p.independent, anticipation: addOutcome(p.independent.anticipation, outcome) };
  return { ...p, predictions, independent, updatedAt: Date.now() };
}

/** Skills the player demonstrably handles well (enough evidence, high success). */
export function isMastered(p: LearningProfile, s: Skill): boolean {
  const r = rating(p.independent[s] ?? emptyStat());
  return (r.confidence === 'moderate' || r.confidence === 'good') && r.mean - r.halfWidth >= 0.7;
}

/** Weakest skills with at least some evidence, for focus recommendations. */
export function focusAreas(p: LearningProfile, n = 3): { skill: Skill; mean: number; confidence: string }[] {
  return SKILLS.filter((s) => s.id !== 'recurring' || (p.independent.recurring?.n ?? 0) >= 5)
    .map((s) => ({ skill: s.id, ...rating(p.independent[s.id] ?? emptyStat()) }))
    .filter((r) => r.confidence !== 'none')
    .sort((a, b) => a.mean - b.mean)
    .slice(0, n)
    .map((r) => ({ skill: r.skill, mean: r.mean, confidence: r.confidence }));
}

/**
 * Adjust the Coach's playing level after a game, from the player's
 * independent accuracy and result. The Coach aims for games the player can
 * learn from: slightly stronger than the player, never crushing.
 */
export function adaptCoachLevel(p: LearningProfile, independentAccuracy: number | null, playerScore: number): LearningProfile {
  let level = p.coachLevel;
  if (playerScore >= 1 && (independentAccuracy ?? 0) >= 70) level += 2;
  else if (playerScore >= 0.5) level += 1;
  else if ((independentAccuracy ?? 100) < 55) level -= 1;
  level = Math.max(1, Math.min(20, level));
  const accuracyHistory = independentAccuracy === null ? p.accuracyHistory : [...p.accuracyHistory, { ts: Date.now(), accuracy: independentAccuracy }].slice(-100);
  return { ...p, coachLevel: level, games: p.games + 1, accuracyHistory, updatedAt: Date.now() };
}
