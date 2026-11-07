import { exportPgn, type ParsedGame } from '../chess/pgn';
import { treeFromMoves, START_FEN, type GameTree } from '../chess/tree';
import { CLASS_INFO } from '../analysis/classify';
import { formatScore } from '../engine/score';
import type { GameResult } from '../chess/rules';
import { get, put } from '../db/db';
import type { GameRecord, GameSource } from '../db/types';
import { newId } from '../util/id';

export function gameFromParsed(p: ParsedGame): GameRecord {
  const now = Date.now();
  const result = (['1-0', '0-1', '1/2-1/2'].includes(p.result) ? p.result : '*') as GameResult;
  return { id: newId('g'), source: 'pgn', headers: p.headers, startFen: p.startFen, moves: p.moves, result, tree: p.tree, createdAt: now, updatedAt: now };
}

export function gameFromMoves(source: GameSource, moves: string[], headers: Record<string, string>, result: GameResult, startFen = START_FEN): GameRecord {
  const now = Date.now();
  return { id: newId('g'), source, headers, startFen, moves, result, tree: treeFromMoves(moves, startFen), createdAt: now, updatedAt: now };
}

export async function saveGame(g: GameRecord) {
  await put('games', { ...g, updatedAt: Date.now() });
}

export async function saveTree(gameId: string, tree: GameTree) {
  const g = await get('games', gameId);
  if (!g) throw new Error('Game not found');
  // the original mainline must be untouched by tree edits
  await put('games', { ...g, tree, updatedAt: Date.now() });
}

export function gameTitle(g: Pick<GameRecord, 'headers' | 'source'>): string {
  const w = g.headers.White && g.headers.White !== '?' ? g.headers.White : 'White';
  const b = g.headers.Black && g.headers.Black !== '?' ? g.headers.Black : 'Black';
  return `${w} vs ${b}`;
}

/** Export a game with its explored variations and (optionally) review annotations. */
export async function gamePgn(g: GameRecord, withReview = true): Promise<string> {
  const review = withReview ? await get('reviews', g.id) : undefined;
  const byNode = new Map(review?.moves.filter(Boolean).map((m) => [m.nodeId, m]) ?? []);
  return exportPgn(g.headers, g.tree, g.result, {
    annotate: (id) => {
      const m = byNode.get(id);
      if (!m) return undefined;
      return `${CLASS_INFO[m.cls].label}${m.provisional ? ' (provisional)' : ''}, eval ${formatScore(m.evalAfter)}${m.bestSan && m.bestSan !== m.san && m.epl >= 5 ? `, best was ${m.bestSan}` : ''}`;
    },
    nags: (id) => {
      const m = byNode.get(id);
      const n = m ? CLASS_INFO[m.cls].nag : undefined;
      return n ? [n] : undefined;
    },
  });
}
