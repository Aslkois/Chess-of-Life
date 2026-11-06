/**
 * Builds src/data/openings.json from the Lichess chess-openings dataset (CC0),
 * stored verbatim in data/openings/*.tsv.
 *
 * Output: { names: [eco, name][], pos: { [hash]: [nameIndex|-1, ...uciMoves] } }
 * Every position that occurs along any catalogued opening line is recorded,
 * together with the catalogued continuations from it. Named positions carry
 * the index of their ECO code/name. Nothing in here is invented: every entry
 * comes from a line in the dataset.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { positionKey, hashKey } from '../src/chess/positionKey';

const names: [string, string][] = [];
const pos: Record<string, { n: number; m: Set<string> }> = {};
const seen = new Map<string, string>();
const get = (fen: string) => {
  const pk = positionKey(fen);
  const k = hashKey(pk);
  const prev = seen.get(k);
  if (prev && prev !== pk) throw new Error(`hash collision: ${prev} vs ${pk}`);
  seen.set(k, pk);
  return (pos[k] ??= { n: -1, m: new Set() });
};

for (const f of ['a', 'b', 'c', 'd', 'e']) {
  const rows = readFileSync(`data/openings/${f}.tsv`, 'utf8').trim().split('\n').slice(1);
  for (const row of rows) {
    const [eco, name, pgn] = row.split('\t');
    const c = new Chess();
    const sans = pgn.replace(/\d+\.(\.\.)?/g, ' ').trim().split(/\s+/);
    for (const san of sans) {
      const before = get(c.fen());
      const mv = c.move(san);
      before.m.add(mv.from + mv.to + (mv.promotion ?? ''));
      get(c.fen());
    }
    const idx = names.push([eco, name]) - 1;
    const entry = get(c.fen());
    // Keep the first (most general) name for a position reached by several lines.
    if (entry.n === -1) entry.n = idx;
  }
}
const out: Record<string, (number | string)[]> = {};
for (const [k, v] of Object.entries(pos)) out[k] = [v.n, ...v.m];
writeFileSync('src/data/openings.json', JSON.stringify({ source: 'lichess-org/chess-openings (CC0-1.0)', names, pos: out }));
console.log(`openings: ${names.length} lines, ${Object.keys(out).length} positions`);
