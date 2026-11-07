import { Chess } from 'chess.js';
import { positionKey } from '../chess/positionKey';
import { trackOpening, type OpeningInfo, type OpeningTrack } from '../analysis/openings';
import type { GameRecord, GameSource, StoredReview } from '../db/types';

/**
 * Personal opening data, computed only from the user's own saved games. A game
 * counts only when the user's side is established (Coach and Ranked games
 * always; imported and reconstructed games when the user set it or a PGN name
 * matches) and each game counts once. Coach games are kept apart from the
 * competitive record because takebacks and hints change their outcome.
 */

export type Side = 'w' | 'b';

/** The user's side in a game: a colour, `null` (not the user's game) or `undefined` (unknown). */
export function playerColorOf(g: Pick<GameRecord, 'playerColor' | 'headers' | 'source'>, names: string[] = []): Side | null | undefined {
  if (g.playerColor !== undefined) return g.playerColor;
  const w = (g.headers.White ?? '').trim().toLowerCase();
  const b = (g.headers.Black ?? '').trim().toLowerCase();
  if (g.source === 'coach' || g.source === 'ranked') {
    if (w === 'you') return 'w';
    if (b === 'you') return 'b';
  }
  const mine = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (!mine.length) return undefined;
  const mw = mine.includes(w);
  const mb = mine.includes(b);
  if (mw !== mb) return mw ? 'w' : 'b';
  return undefined;
}

/** 1 / 0.5 / 0 for the user, or null for an unfinished game. */
export function scoreFor(result: string, side: Side): number | null {
  if (result === '1/2-1/2') return 0.5;
  if (result === '1-0') return side === 'w' ? 1 : 0;
  if (result === '0-1') return side === 'b' ? 1 : 0;
  return null;
}

export interface GameLine { fens: string[]; ucis: string[]; sans: string[]; keys: string[] }
const lineCache = new Map<string, { at: number; line: GameLine; track: OpeningTrack }>();

/** Positions of a game's original mainline (memoised per game version). */
export function gameLine(g: Pick<GameRecord, 'id' | 'updatedAt' | 'moves' | 'startFen'>): { line: GameLine; track: OpeningTrack } {
  const hit = lineCache.get(g.id);
  if (hit && hit.at === g.updatedAt) return hit;
  const c = new Chess(g.startFen);
  const line: GameLine = { fens: [c.fen()], ucis: [], sans: [], keys: [positionKey(c.fen())] };
  for (const san of g.moves) {
    let m;
    try { m = c.move(san); } catch { break; }
    line.ucis.push(m.from + m.to + (m.promotion ?? ''));
    line.sans.push(m.san);
    line.fens.push(c.fen());
    line.keys.push(positionKey(c.fen()));
  }
  const v = { at: g.updatedAt, line, track: trackOpening(line.fens) };
  lineCache.set(g.id, v);
  return v;
}

// ---------------- My Games at a position (Opening Explorer) ----------------

export interface PositionGame { game: GameRecord; ply: number; side: Side; score: number | null; next: { uci: string; san: string } | null }
export interface MoveStat { uci: string; san: string; games: number; w: number; d: number; l: number; unfinished: number }
export interface PositionStats {
  games: PositionGame[];
  moves: MoveStat[];
  /** games that reach the position but whose side is not known (not counted) */
  unknownSide: number;
}

export interface GameFilter {
  /** 'competitive' = Ranked + imported + reconstructed (Coach kept apart) */
  source: 'competitive' | GameSource;
  color: 'both' | Side;
  from?: number;
  to?: number;
  /** 'any', 'untimed' or a Ranked time control like "300+2" */
  timeControl?: string;
}

export const DEFAULT_FILTER: GameFilter = { source: 'competitive', color: 'both', timeControl: 'any' };

export function gameDate(g: GameRecord): number {
  const d = g.headers.Date;
  if (d && /^\d{4}\.\d{2}\.\d{2}$/.test(d)) { const t = Date.parse(d.replace(/\./g, '-')); if (!Number.isNaN(t)) return t; }
  return g.createdAt;
}

export function passesFilter(g: GameRecord, side: Side, f: GameFilter): boolean {
  if (f.source === 'competitive' ? g.source === 'coach' : g.source !== f.source) return false;
  if (f.color !== 'both' && f.color !== side) return false;
  const t = gameDate(g);
  if (f.from !== undefined && t < f.from) return false;
  if (f.to !== undefined && t > f.to) return false;
  if (f.timeControl && f.timeControl !== 'any') {
    const tc = g.headers.TimeControl;
    if (f.timeControl === 'untimed' ? !!tc && tc !== '-' && tc !== '?' : tc !== f.timeControl) return false;
  }
  return true;
}

/** The user's games that reach `fen` (by position key, so transpositions count), each once. */
export function gamesAtPosition(games: GameRecord[], fen: string, names: string[], f: GameFilter = DEFAULT_FILTER): PositionStats {
  const key = positionKey(fen);
  const out: PositionGame[] = [];
  let unknownSide = 0;
  for (const g of games) {
    const side = playerColorOf(g, names);
    if (side === null) continue;
    const { line } = gameLine(g);
    const ply = line.keys.indexOf(key);
    if (ply < 0) continue;
    if (side === undefined) { if (f.source === 'competitive' ? g.source !== 'coach' : g.source === f.source) unknownSide++; continue; }
    if (!passesFilter(g, side, f)) continue;
    out.push({ game: g, ply, side, score: scoreFor(g.result, side), next: ply < line.ucis.length ? { uci: line.ucis[ply], san: line.sans[ply] } : null });
  }
  const byMove = new Map<string, MoveStat>();
  for (const pg of out) {
    if (!pg.next) continue;
    const m = byMove.get(pg.next.uci) ?? { uci: pg.next.uci, san: pg.next.san, games: 0, w: 0, d: 0, l: 0, unfinished: 0 };
    m.games++;
    if (pg.score === null) m.unfinished++; else if (pg.score === 1) m.w++; else if (pg.score === 0) m.l++; else m.d++;
    byMove.set(pg.next.uci, m);
  }
  out.sort((a, b) => gameDate(b.game) - gameDate(a.game));
  return { games: out, moves: [...byMove.values()].sort((a, b) => b.games - a.games), unknownSide };
}

// ---------------- personal opening statistics (Progress) ----------------

export const OPENING_PHASE_PLIES = 24; // the first 12 moves of each side

export interface GameOpeningStat {
  gameId: string;
  title: string;
  date: number;
  source: GameSource;
  side: Side;
  score: number | null;
  opening: OpeningInfo;
  /** position index where the identity was reached (for "open in Explorer") */
  namedAt: number;
  bookPlies: number;
  /** the move that left the catalogued theory, if any */
  exit: { ply: number; san: string; byUser: boolean } | null;
  /** mean accuracy of the user's moves in the first 12 moves (needs a review) */
  openingAccuracy: number | null;
  /** the user's inaccuracies or worse in the first 12 moves (needs a review) */
  earlyErrors: number | null;
  reviewed: boolean;
  timeControl: string | null;
}

/** One game's opening record, or null when it cannot count (side unknown, not the user's game, no identity). */
export function gameOpeningStat(g: GameRecord, review: StoredReview | undefined, names: string[], title = ''): GameOpeningStat | null {
  const side = playerColorOf(g, names);
  if (!side) return null;
  const { line, track } = gameLine(g);
  if (!track.opening) return null;
  const exitPly = track.leftAt;
  const usable = review && (review.status === 'complete' || review.status === 'quick') && review.moves.length > 0;
  const mine = usable ? review!.moves.filter((m) => m && m.color === side && m.ply < OPENING_PHASE_PLIES && !m.forced) : [];
  return {
    gameId: g.id, title, date: gameDate(g), source: g.source, side, score: scoreFor(g.result, side), opening: track.opening,
    namedAt: Math.max(0, track.plies.reduce((at, p) => (p.namedHere ? p.index : at), 0)),
    bookPlies: track.bookPlies,
    exit: exitPly !== null && exitPly < line.sans.length ? { ply: exitPly, san: line.sans[exitPly], byUser: sideAt(line.fens[0], exitPly) === side } : null,
    openingAccuracy: usable && mine.length ? mine.reduce((s, m) => s + m.accuracy, 0) / mine.length : null,
    earlyErrors: usable ? mine.filter((m) => ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(m.cls)).length : null,
    reviewed: !!usable,
    timeControl: g.headers.TimeControl && g.headers.TimeControl !== '-' && g.headers.TimeControl !== '?' ? g.headers.TimeControl : null,
  };
}

/** Who moves at ply index `ply` from `startFen`. */
function sideAt(startFen: string, ply: number): Side {
  const first = startFen.split(' ')[1] === 'b' ? 'b' : 'w';
  return ply % 2 === 0 ? first : first === 'w' ? 'b' : 'w';
}

export interface OpeningNode {
  key: string;
  label: string;
  level: 'family' | 'variation' | 'subvariation';
  ecos: string[];
  games: GameOpeningStat[];
  children: OpeningNode[];
  w: number; d: number; l: number; unfinished: number;
  /** points scored / finished games, as a percentage */
  scorePct: number | null;
  openingAccuracy: number | null;
  reviewedGames: number;
  earlyErrors: number;
  /** games in which the user was the one to leave theory */
  userExits: number;
  exits: { san: string; byUser: boolean; games: number }[];
}

function node(key: string, label: string, level: OpeningNode['level']): OpeningNode {
  return { key, label, level, ecos: [], games: [], children: [], w: 0, d: 0, l: 0, unfinished: 0, scorePct: null, openingAccuracy: null, reviewedGames: 0, earlyErrors: 0, userExits: 0, exits: [] };
}

function finish(n: OpeningNode): OpeningNode {
  let pts = 0;
  let accSum = 0;
  const exits = new Map<string, { san: string; byUser: boolean; games: number }>();
  for (const g of n.games) {
    if (g.score === null) n.unfinished++; else { pts += g.score; if (g.score === 1) n.w++; else if (g.score === 0) n.l++; else n.d++; }
    if (g.openingAccuracy !== null) { accSum += g.openingAccuracy; n.reviewedGames++; }
    n.earlyErrors += g.earlyErrors ?? 0;
    if (g.exit) {
      if (g.exit.byUser) n.userExits++;
      const k = `${g.exit.ply}:${g.exit.san}`;
      const e = exits.get(k) ?? { san: `${Math.floor(g.exit.ply / 2) + 1}${g.exit.ply % 2 === 0 ? '.' : '...'}${g.exit.san}`, byUser: g.exit.byUser, games: 0 };
      e.games++;
      exits.set(k, e);
    }
    if (!n.ecos.includes(g.opening.eco)) n.ecos.push(g.opening.eco);
  }
  const finished = n.w + n.d + n.l;
  n.scorePct = finished ? (pts / finished) * 100 : null;
  n.openingAccuracy = n.reviewedGames ? accSum / n.reviewedGames : null;
  n.exits = [...exits.values()].sort((a, b) => b.games - a.games);
  n.ecos.sort();
  n.children = n.children.map(finish).sort((a, b) => b.games.length - a.games.length || a.label.localeCompare(b.label));
  n.games.sort((a, b) => b.date - a.date);
  return n;
}

/** Group games into family → variation → sub-variation. Every game appears once at each level of its own path. */
export function buildOpeningTree(stats: GameOpeningStat[]): OpeningNode[] {
  const fams = new Map<string, OpeningNode>();
  for (const s of stats) {
    const o = s.opening;
    const fam = fams.get(o.family) ?? node(o.family, o.family, 'family');
    fams.set(o.family, fam);
    fam.games.push(s);
    if (!o.variation) continue;
    const vk = `${o.family}: ${o.variation}`;
    let v = fam.children.find((c) => c.key === vk);
    if (!v) { v = node(vk, o.variation, 'variation'); fam.children.push(v); }
    v.games.push(s);
    if (!o.subvariation) continue;
    const sk = `${vk}, ${o.subvariation}`;
    let sv = v.children.find((c) => c.key === sk);
    if (!sv) { sv = node(sk, o.subvariation, 'subvariation'); v.children.push(sv); }
    sv.games.push(s);
  }
  return [...fams.values()].map(finish).sort((a, b) => b.games.length - a.games.length || a.label.localeCompare(b.label));
}

/** Results per calendar month (for "over time"). */
export function byMonth(games: GameOpeningStat[]): { month: string; games: number; scorePct: number | null }[] {
  const m = new Map<string, { n: number; pts: number; fin: number }>();
  for (const g of games) {
    const d = new Date(g.date);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const e = m.get(k) ?? { n: 0, pts: 0, fin: 0 };
    e.n++;
    if (g.score !== null) { e.pts += g.score; e.fin++; }
    m.set(k, e);
  }
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, e]) => ({ month, games: e.n, scorePct: e.fin ? (e.pts / e.fin) * 100 : null }));
}

/** Filter and compute per-game stats; reports how many games could not be counted and why. */
export function openingStats(games: GameRecord[], reviews: Map<string, StoredReview>, names: string[], f: GameFilter, title: (g: GameRecord) => string = () => '') {
  const counted: GameOpeningStat[] = [];
  let unknownSide = 0;
  let noOpening = 0;
  for (const g of games) {
    const side = playerColorOf(g, names);
    if (side === null) continue;
    if (side === undefined) { if (f.source === 'competitive' ? g.source !== 'coach' : g.source === f.source) unknownSide++; continue; }
    if (!passesFilter(g, side, f)) continue;
    const s = gameOpeningStat(g, reviews.get(g.id), names, title(g));
    if (!s) { noOpening++; continue; }
    counted.push(s);
  }
  return { counted, unknownSide, noOpening, tree: buildOpeningTree(counted) };
}
