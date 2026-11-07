import data from '../data/openings.json';
import { hashKey, positionKey } from '../chess/positionKey';

/**
 * Opening reference built from the Lichess chess-openings dataset (CC0).
 * "Book" status is only ever granted when a position occurs on a catalogued
 * opening line – theory is never inferred or invented.
 */
interface OpeningData { names: [string, string][]; pos: Record<string, (number | string)[]> }
const DB = data as unknown as OpeningData;

export interface OpeningInfo { eco: string; name: string }

function entry(fen: string) {
  return DB.pos[hashKey(positionKey(fen))];
}

export function isBookPosition(fen: string): boolean {
  return !!entry(fen);
}

export function openingName(fen: string): OpeningInfo | null {
  const e = entry(fen);
  if (!e || (e[0] as number) < 0) return null;
  const [eco, name] = DB.names[e[0] as number];
  return { eco, name };
}

/** Catalogued continuations (UCI) from this position. */
export function bookMoves(fen: string): string[] {
  const e = entry(fen);
  return e ? (e.slice(1) as string[]) : [];
}

/** Is `uci` a catalogued continuation from `fenBefore`? */
export function isBookMove(fenBefore: string, uci: string): boolean {
  return bookMoves(fenBefore).includes(uci);
}

/**
 * Identify the opening of a game from its sequence of positions: the deepest
 * named position reached while every move so far is a catalogued continuation.
 * Returns the number of plies that were "in book".
 */
export function identifyOpening(fens: string[], ucis: string[]): { opening: OpeningInfo | null; bookPlies: number } {
  let opening: OpeningInfo | null = null;
  let bookPlies = 0;
  for (let i = 0; i < ucis.length; i++) {
    if (!isBookMove(fens[i], ucis[i])) break;
    bookPlies = i + 1;
    const n = openingName(fens[i + 1]);
    if (n) opening = n;
  }
  return { opening, bookPlies };
}

export const OPENING_COUNT = DB.names.length;
