/**
 * Builds src/data/openings.json from the Lichess chess-openings dataset (CC0),
 * stored verbatim in data/openings/*.tsv.
 *
 * Output: { names: [eco, name][], pos: { [hash]: [nameIndex|-1, uci, lines, uci, lines, ...] } }
 * Every position that occurs along any catalogued opening line is recorded,
 * with each catalogued continuation from it and the number of catalogued
 * lines that pass through that continuation. Named positions carry the index
 * of their ECO code and name (no two lines in the dataset end in the same
 * position, which the build checks). Nothing in here is invented: every entry
 * comes from a line in the dataset.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { Chess } from 'chess.js';
import { positionKey, hashKey } from '../src/chess/positionKey';

const names: [string, string][] = [];
const pos: Record<string, { n: number; m: Map<string, number> }> = {};
const seen = new Map<string, string>();
const get = (fen: string) => {
  const pk = positionKey(fen);
  const k = hashKey(pk);
  const prev = seen.get(k);
  if (prev && prev !== pk) throw new Error(`hash collision: ${prev} vs ${pk}`);
  seen.set(k, pk);
  return (pos[k] ??= { n: -1, m: new Map() });
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
      const uci = mv.from + mv.to + (mv.promotion ?? '');
      before.m.set(uci, (before.m.get(uci) ?? 0) + 1);
      get(c.fen());
    }
    const idx = names.push([eco, name]) - 1;
    const entry = get(c.fen());
    if (entry.n !== -1) throw new Error(`two lines end in the same position: ${names[entry.n].join(' ')} and ${eco} ${name}`);
    entry.n = idx;
  }
}
const out: Record<string, (number | string)[]> = {};
for (const [k, v] of Object.entries(pos)) {
  const moves = [...v.m.entries()].sort((a, b) => b[1] - a[1]);
  out[k] = [v.n, ...moves.flat()];
}
writeFileSync('src/data/openings.json', JSON.stringify({ source: 'lichess-org/chess-openings (CC0-1.0)', names, pos: out }));
console.log(`openings: ${names.length} lines, ${Object.keys(out).length} positions`);
