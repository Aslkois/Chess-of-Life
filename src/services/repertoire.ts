import { all, del, get, put } from '../db/db';
import type { DrillRecord, RepertoireLine } from '../db/types';
import { parsePgn } from '../chess/pgn';
import { START_FEN, treeFromMoves } from '../chess/tree';
import { exportPgn } from '../chess/pgn';
import { normaliseLine, recordDrill, drillId, type Side } from '../openings/repertoire';
import { newId } from '../util/id';

export async function listLines(): Promise<RepertoireLine[]> {
  return (await all('repertoire')).sort((a, b) => a.color.localeCompare(b.color) || a.name.localeCompare(b.name));
}

export async function addLine(name: string, color: Side, moves: string[], note?: string): Promise<RepertoireLine> {
  const now = Date.now();
  const line: RepertoireLine = { id: newId('rl'), name: name.trim() || 'Untitled line', color, moves: normaliseLine(moves), note, createdAt: now, updatedAt: now };
  await put('repertoire', line);
  return line;
}

export async function updateLine(line: RepertoireLine) {
  await put('repertoire', { ...line, moves: normaliseLine(line.moves), updatedAt: Date.now() });
}

export async function deleteLine(id: string) {
  await del('repertoire', id);
}

export async function listDrills(): Promise<DrillRecord[]> {
  return all('drills');
}

export async function saveDrillResult(color: Side, fen: string, expected: string[], firstTry: boolean, wrong: string[]): Promise<DrillRecord> {
  const prev = await get('drills', drillId(color, fen));
  const r = recordDrill(prev, color, fen, expected, firstTry, wrong);
  await put('drills', r);
  return r;
}

/** Repertoire as PGN: one game per line, with the side in a custom header. */
export function repertoireToPgn(lines: RepertoireLine[]): string {
  return lines.map((l) => exportPgn({
    Event: `Repertoire: ${l.name}`, Site: 'Chess of Life', White: l.color === 'w' ? 'Me' : '?', Black: l.color === 'b' ? 'Me' : '?', Result: '*', RepertoireColor: l.color === 'w' ? 'White' : 'Black',
  }, treeFromMoves(l.moves, START_FEN), '*')).join('\n\n');
}

/** Read lines from PGN text. The side comes from a RepertoireColor header, else `fallback`. */
export function linesFromPgn(text: string, fallback: Side): { lines: { name: string; color: Side; moves: string[] }[]; errors: string[] } {
  const r = parsePgn(text);
  const out: { name: string; color: Side; moves: string[] }[] = [];
  const errors: string[] = [...r.errors];
  r.games.forEach((g, i) => {
    if (g.startFen !== START_FEN) { errors.push(`Game ${i + 1}: repertoire lines must start from the standard position.`); return; }
    if (!g.moves.length) { errors.push(`Game ${i + 1}: no moves.`); return; }
    const rc = (g.headers.RepertoireColor ?? '').toLowerCase();
    const color: Side = rc === 'black' ? 'b' : rc === 'white' ? 'w' : g.headers.Black === 'Me' ? 'b' : g.headers.White === 'Me' ? 'w' : fallback;
    const name = (g.headers.Event ?? '').replace(/^Repertoire:\s*/, '') || `Imported line ${i + 1}`;
    out.push({ name, color, moves: g.moves });
  });
  return { lines: out, errors };
}
