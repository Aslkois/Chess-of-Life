import { all, del, get, put } from '../db/db';
import type { CoachAttempt, PredictionRecord } from '../db/types';
import { emptyProfile, recordDecision, recordPrediction, adaptCoachLevel, type LearningProfile } from '../coach/profile';
import { isInformative, outcomeOf, tagSkills } from '../coach/skills';
import type { CoachState } from '../coach/session';
import { gameFromMoves, saveGame } from './games';
import { newId } from '../util/id';

export async function loadCoachProfile(): Promise<LearningProfile> {
  const p = (await get('profiles', 'coach')) as LearningProfile | undefined;
  return p ?? emptyProfile();
}

export async function saveCoachProfile(p: LearningProfile) {
  await put('profiles', p);
}

export async function persistCoachState(s: CoachState) {
  await put('coachSessions', s.session);
  for (const a of s.attempts) await put('coachAttempts', a);
}

/**
 * Feed one evaluated attempt into the learning profile. Independent and
 * assisted evidence are stored separately.
 */
export function evidenceFromAttempt(p: LearningProfile, a: CoachAttempt, bestUci: string | null, winBest: number, replyUci?: string, errorMotifs: string[] = []): LearningProfile {
  if (a.epl === null) return p;
  if (!isInformative(winBest, a.epl)) return a.tookBack ? { ...p, takebacks: p.takebacks + 1 } : p;
  const skills = tagSkills({ fenBefore: a.fen, uci: a.uci, bestUci, epl: a.epl, ply: a.ply + 1, winBest, replyUci });
  let next = recordDecision(p, { skills, outcome: outcomeOf(a.epl), independent: a.independent, errorMotifs });
  if (a.tookBack) next = { ...next, takebacks: next.takebacks + 1 };
  return next;
}

export async function savePrediction(r: Omit<PredictionRecord, 'id' | 'ts'>, outcome: number) {
  await put('predictions', { ...r, id: newId('pr'), ts: Date.now() });
  const p = await loadCoachProfile();
  await saveCoachProfile(recordPrediction(p, r.category, outcome));
}

/**
 * Finish a Coach game: store it as a reviewable game and adapt the Coach
 * level. A game reopened with Take back and finished again updates the same
 * saved game, and the level adaptation is applied only once per session.
 */
export async function finishCoachGame(s: CoachState, independentAccuracy: number | null): Promise<string> {
  const playerScore = s.session.result === '1/2-1/2' ? 0.5 : (s.session.result === '1-0') === (s.session.playerColor === 'w') ? 1 : 0;
  const g = gameFromMoves('coach', s.session.moves, {
    Event: 'Coach game', White: s.session.playerColor === 'w' ? 'You' : `Coach (level ${s.session.coachLevel})`,
    Black: s.session.playerColor === 'b' ? 'You' : `Coach (level ${s.session.coachLevel})`, Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
    Result: s.session.result,
  }, s.session.result, s.session.startFen);
  g.coachSessionId = s.session.id;
  g.playerColor = s.session.playerColor;
  if (s.session.gameId) {
    const existing = await get('games', s.session.gameId);
    if (existing) { g.id = existing.id; g.createdAt = existing.createdAt; }
    else g.id = s.session.gameId;
    await del('reviews', g.id); // the moves changed: the old review no longer applies
  }
  await saveGame(g);
  const session = { ...s.session, gameId: g.id, profileApplied: true };
  await persistCoachState({ ...s, session });
  const p = await loadCoachProfile();
  if (!s.session.profileApplied) {
    await saveCoachProfile({ ...adaptCoachLevel(p, independentAccuracy, playerScore), hintsUsed: p.hintsUsed + s.session.hintsUsed });
  }
  return g.id;
}

export async function listCoachSessions() {
  return (await all('coachSessions')).sort((a, b) => b.createdAt - a.createdAt);
}
