import { get, put } from '../db/db';
import { reviewGame, type GameReview } from '../analysis/review';
import type { GameRecord, RankedMatch } from '../db/types';
import { getEngine } from '../engine/instance';
import { learnFromRankedGame } from './ranked';

/**
 * One review run per game at a time, shared by every screen that wants it
 * (e.g. the Ranked results screen and the Review page).
 */
interface Run { listeners: Set<(r: GameReview) => void>; last: GameReview | null; promise: Promise<GameReview>; abort: AbortController }
const runs = new Map<string, Run>();

export function isReviewRunning(gameId: string) {
  return runs.has(gameId);
}

export function ensureReview(g: GameRecord, opts: { quickDepth: number; deepDepth: number }, onUpdate: (r: GameReview) => void): () => void {
  let run = runs.get(g.id);
  if (!run) {
    const abort = new AbortController();
    const listeners = new Set<(r: GameReview) => void>();
    let lastSave = 0;
    const r: Run = { listeners, last: null, abort, promise: Promise.resolve(null as unknown as GameReview) };
    r.promise = reviewGame(getEngine(), g.id, g.tree, {
      quickDepth: opts.quickDepth, deepDepth: opts.deepDepth, multipv: 3, signal: abort.signal,
      onUpdate: (rev) => {
        r.last = rev;
        for (const l of listeners) l(rev);
        const now = Date.now();
        if (rev.status !== 'running' || now - lastSave > 3000) { lastSave = now; void put('reviews', rev); }
      },
    }).then(async (rev) => {
      runs.delete(g.id);
      await put('reviews', rev);
      if (rev.status === 'complete' && g.rankedMatchId) {
        const m = (await get('rankedMatches', g.rankedMatchId)) as RankedMatch | undefined;
        if (m && !m.analysisDone) await learnFromRankedGame(m, rev);
      }
      return rev;
    });
    run = r;
    runs.set(g.id, r);
  }
  run.listeners.add(onUpdate);
  if (run.last) onUpdate(run.last);
  const rr = run;
  return () => { rr.listeners.delete(onUpdate); };
}

/** Stop a review only if nobody is listening any more (e.g. leaving the page). Ranked reviews keep running so the Rival can learn. */
export function releaseReview(g: GameRecord) {
  const run = runs.get(g.id);
  if (run && run.listeners.size === 0 && !g.rankedMatchId) run.abort.abort();
}
