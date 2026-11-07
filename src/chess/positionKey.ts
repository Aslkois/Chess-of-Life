import { Chess } from 'chess.js';

/**
 * A transposition-safe key for a chess position: piece placement, side to move,
 * castling rights and an en-passant square only when an en-passant capture is
 * actually legal (FIDE repetition semantics). Move counters are excluded, so
 * the same position reached by different move orders shares one key.
 */
export function positionKey(fen: string): string {
  const parts = fen.trim().split(/\s+/);
  const [placement, turn, castling, ep] = parts;
  let epField = '-';
  if (ep && ep !== '-') {
    try {
      const c = new Chess(fen);
      const legalEp = c.moves({ verbose: true }).some((m) => m.flags.includes('e'));
      if (legalEp) epField = ep;
    } catch {
      epField = '-';
    }
  }
  return `${placement} ${turn} ${castling || '-'} ${epField}`;
}

/** 53-bit FNV-1a style hash rendered base36 – used for compact opening-book keys. */
export function hashKey(s: string): string {
  let h1 = 0x811c9dc5 ^ 0;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    h2 ^= h2 >>> 15;
  }
  const hi = h2 & 0x1fffff; // 21 bits
  return (hi * 2 ** 32 + h1).toString(36);
}
