import { Chess } from 'chess.js';
import { positionKey } from '../chess/positionKey';
import type { GameRecord } from '../db/types';
import { gameDate, gameLine, passesFilter, playerColorOf, type GameFilter } from '../services/openings';
import type { ExGame, ExMove, ExResult } from './types';

/**
 * The "My Games" database: every game saved or imported into Chess of Life,
 * explored by position (transpositions share statistics). Results are counted
 * from White's and Black's point of view like any game database; "playing as"
 * and the player name select whose games are counted.
 */
export interface LocalFilter {
  /** which saved games: all, or only one source */
  source: 'all' | GameRecord['source'];
  /** only games where you played this colour (needs your side to be known) */
  as: 'any' | 'w' | 'b';
  /** only games with this player (White or Black header, case-insensitive) */
  player?: string;
  /** player plays this colour (with `player`) */
  playerColor?: 'any' | 'w' | 'b';
  from?: number;
  to?: number;
  timeControl?: string;
}
export const DEFAULT_LOCAL: LocalFilter = { source: 'all', as: 'any', playerColor: 'any', timeControl: 'any' };

export function localExplorer(games: GameRecord[], fen: string, f: LocalFilter, names: string[] = []): ExResult {
  const key = positionKey(fen);
  const byMove = new Map<string, ExMove>();
  const reached: ExGame[] = [];
  let white = 0, draws = 0, black = 0;
  const who = f.player?.trim().toLowerCase();
  for (const g of games) {
    if (f.source !== 'all' && g.source !== f.source) continue;
    if (f.as !== 'any' && playerColorOf(g, names) !== f.as) continue;
    if (who) {
      const w = (g.headers.White ?? '').toLowerCase() === who;
      const b = (g.headers.Black ?? '').toLowerCase() === who;
      if (f.playerColor === 'w' ? !w : f.playerColor === 'b' ? !b : !(w || b)) continue;
    }
    const gf: GameFilter = { source: g.source, color: 'both', from: f.from, to: f.to, timeControl: f.timeControl };
    if (!passesFilter(g, 'w', gf)) continue;
    const { line } = gameLine(g);
    const ply = line.keys.indexOf(key);
    if (ply < 0) continue;
    const res = g.result === '1-0' ? 'white' : g.result === '0-1' ? 'black' : g.result === '1/2-1/2' ? 'draw' : null;
    if (res === null) continue; // unfinished games have no result to count
    if (res === 'white') white++; else if (res === 'black') black++; else draws++;
    const next = ply < line.ucis.length ? line.ucis[ply] : null;
    if (next) {
      const m = byMove.get(next) ?? { uci: next, san: line.sans[ply], white: 0, draws: 0, black: 0, opening: null };
      if (res === 'white') m.white++; else if (res === 'black') m.black++; else m.draws++;
      byMove.set(next, m);
    }
    reached.push({
      id: g.id, source: 'local', ply,
      white: { name: g.headers.White && g.headers.White !== '?' ? g.headers.White : 'White', rating: Number(g.headers.WhiteElo) || undefined },
      black: { name: g.headers.Black && g.headers.Black !== '?' ? g.headers.Black : 'Black', rating: Number(g.headers.BlackElo) || undefined },
      winner: res === 'draw' ? null : res, date: new Date(gameDate(g)).toISOString().slice(0, 10), uci: next ?? undefined,
    });
  }
  const moves = [...byMove.values()].sort((a, b) => (b.white + b.draws + b.black) - (a.white + a.draws + a.black));
  reached.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { db: 'local', white, draws, black, moves, topGames: [], recentGames: reached.slice(0, 20), opening: null, fetchedAt: Date.now() };
}

/** Legal moves from `fen` that the database has no games for. */
export function movesNotInDatabase(fen: string, listed: string[]): { uci: string; san: string }[] {
  const set = new Set(listed);
  return new Chess(fen).moves({ verbose: true }).map((m) => ({ uci: m.from + m.to + (m.promotion ?? ''), san: m.san })).filter((m) => !set.has(m.uci));
}
