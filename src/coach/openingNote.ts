import { continuations, trackOpening } from '../analysis/openings';

/**
 * A short note about the opening after a move has been played (never before:
 * it would give away theory the player is meant to find). `fens` runs from the
 * start through the position after the move; `moveIdx` is the move's ply index.
 */
export function openingNote(fens: string[], sans: string[], moveIdx: number, by: 'you' | 'coach'): string | null {
  if (fens.length < moveIdx + 2) return null;
  const t = trackOpening(fens.slice(0, moveIdx + 2));
  const p = t.plies[moveIdx + 1];
  const prev = t.plies[moveIdx];
  const san = sans[moveIdx];
  const who = by === 'you' ? 'Your move' : 'The Coach’s move';
  if (p.event === 'book' && p.namedHere && prev.opening?.name !== p.namedHere.name) return `${who} ${san} is a catalogued continuation: this is the ${p.namedHere.name} (${p.namedHere.eco}).`;
  if (p.event === 'reentered') return `${who} ${san} brings the game back into catalogued theory by transposition${p.opening ? `: ${p.opening.name}` : ''}.`;
  if (p.event === 'left') {
    const known = continuations(fens[moveIdx]).slice(0, 3).map((c) => c.san);
    return `${who} ${san} leaves the catalogued theory${prev.opening ? ` of the ${prev.opening.name}` : ''}.${known.length ? ` Catalogued here: ${known.join(', ')}.` : ''} Leaving theory is not a mistake in itself.`;
  }
  return null;
}
