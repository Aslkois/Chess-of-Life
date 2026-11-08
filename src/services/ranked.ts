import { all, get, put } from '../db/db';
import type { RankedMatch, RankedProfile, RivalAdaptation } from '../db/types';
import { emptyRankedProfile, applyResult, playerScore } from '../rival/ranked';
import { emptyRivalModel, updateRivalModel, type RivalModel } from '../rival/model';
import { deriveStrategy } from '../rival/policy';
import type { GameReview } from '../analysis/review';
import { identifyOpening } from '../analysis/openings';
import { Chess } from 'chess.js';
import { newId } from '../util/id';

export async function loadRankedProfile(): Promise<RankedProfile> {
  return ((await get('profiles', 'ranked')) as RankedProfile | undefined) ?? emptyRankedProfile();
}

export async function loadRivalModel(): Promise<RivalModel> {
  return ((await get('profiles', 'rival')) as RivalModel | undefined) ?? emptyRivalModel();
}

export async function saveMatch(m: RankedMatch) {
  await put('rankedMatches', { ...m, updatedAt: Date.now() });
}

/** Step 1 when a match ends: the rating update (does not depend on analysis). */
export async function recordRankedResult(match: RankedMatch): Promise<{ match: RankedMatch; profile: RankedProfile }> {
  const profile = await loadRankedProfile();
  const r = applyResult(profile, match);
  await put('profiles', r.profile);
  await saveMatch(r.match);
  return r;
}

export function fensOf(match: RankedMatch): string[] {
  const c = new Chess(match.startFen);
  const fens = [c.fen()];
  for (const s of match.moves) { c.move(s); fens.push(c.fen()); }
  return fens;
}

/**
 * Step 2, after post-game analysis: update the Rival's player model from the
 * committed moves of THIS ranked game only, and log what changed.
 */
export async function learnFromRankedGame(match: RankedMatch, review: GameReview): Promise<RivalAdaptation> {
  const model = await loadRivalModel();
  const fens = fensOf(match);
  const { opening, bookPlies } = identifyOpening(fens, match.ucis);
  const score = playerScore(match) ?? 0.5;
  const upd = updateRivalModel(model, {
    matchId: match.id,
    playerColor: match.playerColor,
    score,
    opening: opening ? { key: opening.eco + ' ' + opening.name.split(':')[0], name: opening.name.split(':')[0], line: match.ucis.slice(0, Math.max(bookPlies, 2)) } : null,
    review,
    fens,
    // premoved moves took no thinking time: leave them out of the time-use model
    timeSpent: match.timeSpent.map((t, i) => (match.premovePlies?.includes(i) ? undefined : t)),
    clockAfter: match.clockAfter.map((x) => (x < 0 ? undefined : x)),
    initialMs: match.timeControl.initial * 1000,
  });
  await put('profiles', upd.model);
  const nextStrategy = deriveStrategy(upd.model, match.playerColor === 'w' ? 'b' : 'w');
  const adaptation: RivalAdaptation = { id: newId('ad'), matchId: match.id, ts: Date.now(), changes: upd.changes, strategyNotes: nextStrategy.notes };
  await put('rivalAdaptations', adaptation);
  await saveMatch({ ...match, analysisDone: true });
  return adaptation;
}

export async function listMatches(): Promise<RankedMatch[]> {
  return (await all('rankedMatches')).sort((a, b) => b.createdAt - a.createdAt);
}

export async function listAdaptations(): Promise<RivalAdaptation[]> {
  return (await all('rivalAdaptations')).sort((a, b) => b.ts - a.ts);
}
