import { Chess } from 'chess.js';
import data from '../data/openings.json';
import { hashKey, positionKey } from '../chess/positionKey';

/**
 * Opening reference built from the Lichess chess-openings dataset (CC0-1.0,
 * stored verbatim in data/openings/). Every position on a catalogued line is
 * "in book"; only positions where a catalogued line ends carry a name.
 * Positions are keyed transposition-safely (placement, side to move,
 * castling, legal en passant), so a different move order reaching the same
 * position gets the same name and book status. Theory is never inferred or
 * invented: anything not in the dataset is reported as unknown.
 */
interface OpeningData { names: [string, string][]; pos: Record<string, (number | string)[]> }
const DB = data as unknown as OpeningData;

export interface OpeningInfo {
  eco: string;
  /** the dataset's full name, e.g. "Sicilian Defense: Najdorf Variation, English Attack" */
  name: string;
  /** "Sicilian Defense" */
  family: string;
  /** "Najdorf Variation", or null for the family's own position */
  variation: string | null;
  /** "English Attack" (everything after the variation), or null */
  subvariation: string | null;
}

/** Split a dataset name into family, variation and sub-variation. */
export function parseOpeningName(name: string): Pick<OpeningInfo, 'family' | 'variation' | 'subvariation'> {
  const i = name.indexOf(':');
  if (i < 0) return { family: name.trim(), variation: null, subvariation: null };
  const family = name.slice(0, i).trim();
  const rest = name.slice(i + 1).split(',').map((s) => s.trim()).filter(Boolean);
  return { family, variation: rest[0] ?? null, subvariation: rest.length > 1 ? rest.slice(1).join(', ') : null };
}

const infoCache = new Map<number, OpeningInfo>();
function info(idx: number): OpeningInfo {
  let o = infoCache.get(idx);
  if (!o) {
    const [eco, name] = DB.names[idx];
    o = { eco, name, ...parseOpeningName(name) };
    infoCache.set(idx, o);
  }
  return o;
}

function entry(fen: string) {
  return DB.pos[hashKey(positionKey(fen))];
}

/** Is this position on any catalogued opening line? */
export function isBookPosition(fen: string): boolean {
  return !!entry(fen);
}

/** The opening named at exactly this position (null if the position carries no name). */
export function openingName(fen: string): OpeningInfo | null {
  const e = entry(fen);
  if (!e || (e[0] as number) < 0) return null;
  return info(e[0] as number);
}
export const openingAt = openingName;

/** Catalogued continuations (UCI) from this position, most common first. */
export function bookMoves(fen: string): string[] {
  const e = entry(fen);
  if (!e) return [];
  const out: string[] = [];
  for (let i = 1; i < e.length; i += 2) out.push(e[i] as string);
  return out;
}

/** Is `uci` a catalogued continuation from `fenBefore`? */
export function isBookMove(fenBefore: string, uci: string): boolean {
  return bookMoves(fenBefore).includes(uci);
}

export interface Continuation {
  uci: string;
  san: string;
  /** number of catalogued lines in the dataset that continue with this move (not a game count) */
  lines: number;
  /** the name of the position after the move, if it is a named position */
  opening: OpeningInfo | null;
  fenAfter: string;
}

/** Catalogued continuations with the number of dataset lines through each. */
export function continuations(fen: string): Continuation[] {
  const e = entry(fen);
  if (!e) return [];
  const out: Continuation[] = [];
  for (let i = 1; i < e.length; i += 2) {
    const uci = e[i] as string;
    const c = new Chess(fen);
    let san: string;
    try { san = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { continue; }
    out.push({ uci, san, lines: e[i + 1] as number, opening: openingName(c.fen()), fenAfter: c.fen() });
  }
  return out;
}

/** What the reference knows about one position of a game. */
export interface OpeningPly {
  /** index into the position list (0 = start position) */
  index: number;
  /** the position is on a catalogued line */
  inBook: boolean;
  /** the move into this position: 'start' (no move), 'book' (stays in or re-enters theory), 'left' (leaves theory), 'out' (still outside theory) */
  event: 'start' | 'book' | 'left' | 'out' | 'reentered';
  /** a catalogued line ends exactly here */
  namedHere: OpeningInfo | null;
  /** last known identity: the deepest named position reached so far along this path */
  opening: OpeningInfo | null;
  /** index of the last position on this path that was in book (≤ index) */
  lastBookIndex: number;
}

export interface OpeningTrack {
  plies: OpeningPly[];
  /** the identity at the end of the path (deepest named position reached, including after re-entering theory) */
  opening: OpeningInfo | null;
  /** number of moves of the initial unbroken run inside theory (transpositions count as theory) */
  bookPlies: number;
  /** ply index (0-based move number) of the first move that left theory, or null */
  leftAt: number | null;
  /** the path came back into catalogued theory after leaving it */
  reentered: boolean;
}

/**
 * Follow a game through the reference. A move is "in theory" when it leads to
 * a catalogued position from a catalogued position – this includes reaching a
 * catalogued position by a move order the dataset does not list
 * (transposition). Leaving theory is recorded, as is coming back into it.
 * The identity is only ever a name that was actually reached, so a game is
 * never labelled with a variation it did not get to.
 */
export function trackOpening(fens: string[]): OpeningTrack {
  const plies: OpeningPly[] = [];
  let opening: OpeningInfo | null = null;
  let lastBook = -1;
  let bookPlies = 0;
  let unbroken = true;
  let leftAt: number | null = null;
  let reentered = false;
  for (let i = 0; i < fens.length; i++) {
    const inBook = isBookPosition(fens[i]);
    const namedHere = inBook ? openingName(fens[i]) : null;
    if (namedHere) opening = namedHere;
    let event: OpeningPly['event'] = 'start';
    if (i > 0) {
      const prevIn = plies[i - 1].inBook;
      if (inBook) event = prevIn ? 'book' : 'reentered';
      else event = prevIn ? 'left' : 'out';
      if (event === 'left' && leftAt === null) leftAt = i - 1;
      if (event === 'reentered') reentered = true;
      if (unbroken && inBook) bookPlies = i; else unbroken = false;
    } else if (!inBook) unbroken = false;
    if (inBook) lastBook = i;
    plies.push({ index: i, inBook, event, namedHere, opening, lastBookIndex: lastBook });
  }
  return { plies, opening, bookPlies, leftAt, reentered };
}

/**
 * Identify the opening of a game from its sequence of positions. Kept for
 * existing callers: `bookPlies` is the initial unbroken run in theory.
 */
export function identifyOpening(fens: string[], _ucis?: string[]): { opening: OpeningInfo | null; bookPlies: number } {
  const t = trackOpening(fens);
  return { opening: t.opening, bookPlies: t.bookPlies };
}

/** All positions along a SAN/UCI move list from a start position. */
export function fensOf(moves: string[], startFen?: string): string[] {
  const c = startFen ? new Chess(startFen) : new Chess();
  const out = [c.fen()];
  for (const m of moves) {
    try {
      if (/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(m)) c.move({ from: m.slice(0, 2), to: m.slice(2, 4), promotion: m[4] });
      else c.move(m);
    } catch { break; }
    out.push(c.fen());
  }
  return out;
}

export const OPENING_COUNT = DB.names.length;
export const OPENING_SOURCE = 'lichess-org/chess-openings, CC0-1.0 (public domain dedication)';
