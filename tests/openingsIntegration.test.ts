import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { Chess } from 'chess.js';
import { closeDb, DB_NAME, DB_VERSION, exportAll, get, importBackup, listGames, deleteAllData } from '../src/db/db';
import { openingNote } from '../src/coach/openingNote';
import { fensOf } from '../src/analysis/openings';
import { addLine, linesFromPgn, listLines, repertoireToPgn, saveDrillResult } from '../src/services/repertoire';
import { addMove, mainline } from '../src/chess/tree';
import { exportPgn } from '../src/chess/pgn';
import { gameFromMoves } from '../src/services/games';
import { ALL_ASSISTS, allowed } from '../src/modes';

describe('database upgrade to the repertoire schema', () => {
  it('keeps existing games when a version 1 database is upgraded', async () => {
    await closeDb();
    indexedDB.deleteDatabase(DB_NAME);
    const v1 = await openDB(DB_NAME, 1, {
      upgrade(db) {
        const games = db.createObjectStore('games', { keyPath: 'id' });
        games.createIndex('byCreated', 'createdAt');
        games.createIndex('bySource', 'source');
        for (const s of ['drafts', 'coachSessions', 'coachAttempts', 'predictions', 'profiles', 'rankedMatches', 'rivalAdaptations']) db.createObjectStore(s, { keyPath: 'id' });
        db.createObjectStore('reviews', { keyPath: 'gameId' });
        db.createObjectStore('engineCache', { keyPath: 'key' });
        db.createObjectStore('prefs', { keyPath: 'key' });
      },
    });
    const g = gameFromMoves('pgn', ['e4', 'c5'], { White: 'a', Black: 'b' }, '*');
    await v1.put('games', g);
    v1.close();
    expect(DB_VERSION).toBe(2);
    const games = await listGames();
    expect(games.map((x) => x.id)).toEqual([g.id]);
    expect(games[0].playerColor).toBeUndefined(); // unknown side, not guessed
    await addLine('Sicilian', 'b', ['e4', 'c5']);
    expect((await listLines()).map((l) => l.name)).toEqual(['Sicilian']);
  });

  it('backs up and restores the repertoire and practice records', async () => {
    await deleteAllData();
    await addLine('Italian', 'w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    await saveDrillResult('w', new Chess().fen(), ['e2e4'], false, ['d2d4']);
    const b = await exportAll();
    expect(b.stores.repertoire).toHaveLength(1);
    expect(b.stores.drills).toHaveLength(1);
    await deleteAllData();
    await importBackup(JSON.parse(JSON.stringify(b)));
    expect((await listLines())[0].moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']);
    expect((await get('drills', `w|${new Chess().fen().split(' ').slice(0, 3).join(' ')} -`))?.misses).toBe(1);
  });

  it('exports and re-imports repertoire lines as PGN', async () => {
    await deleteAllData();
    await addLine('Najdorf', 'b', ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);
    const pgn = repertoireToPgn(await listLines());
    expect(pgn).toContain('[RepertoireColor "Black"]');
    const back = linesFromPgn(pgn, 'w');
    expect(back.errors).toEqual([]);
    expect(back.lines[0]).toMatchObject({ name: 'Najdorf', color: 'b' });
    expect(back.lines[0].moves).toHaveLength(10);
  });
});

describe('Coach opening notes (after the move only)', () => {
  const play = (moves: string[]) => fensOf(moves);
  it('names the opening when a move reaches a named position', () => {
    const m = ['e4', 'c5'];
    expect(openingNote(play(m), m, 1, 'you')).toBe('Your move c5 is a catalogued continuation: this is the Sicilian Defense (B20).');
  });
  it('says when a move leaves theory, without calling it a mistake', () => {
    const m = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Kf1'];
    const n = openingNote(play(m), m, 6, 'you')!;
    expect(n).toMatch(/^Your move Kf1 leaves the catalogued theory of the Italian Game: Giuoco Piano\./);
    expect(n).toMatch(/Catalogued here: b4, c3, O-O\./); // most-catalogued first (the Evans Gambit has the most lines)
    expect(n).toMatch(/not a mistake in itself/);
  });
  it('reports transpositions back into theory, and stays quiet otherwise', () => {
    const m = ['d4', 'Nf6', 'Bg5', 'e6', 'c4', 'd5', 'Nc3', 'Be7'];
    const f = play(m);
    const notes = m.map((_, i) => openingNote(f, m, i, i % 2 ? 'coach' : 'you'));
    expect(notes.some((x) => x?.includes('back into catalogued theory'))).toBe(true);
    const quiet = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Kf1', 'Nf6'];
    expect(openingNote(play(quiet), quiet, 7, 'coach')).toBeNull(); // still outside theory: nothing to say
  });
});

describe('Tree of Life: catalogued theory branches', () => {
  it('stores theory branches with their own source and marks them in PGN', () => {
    const g = gameFromMoves('pgn', ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], {}, '*');
    const at = mainline(g.tree)[4]; // after 2...Nc6
    const r = addMove(g.tree, at, { from: 'f1', to: 'c4' }, 'theory');
    expect(r.tree.nodes[r.nodeId].source).toBe('theory');
    expect(mainline(r.tree)).toHaveLength(6); // the original game is untouched
    const pgn = exportPgn({}, r.tree, '*');
    expect(pgn).toContain('(3. Bc4 {[catalogued theory]})');
  });
});

describe('Ranked integrity for opening aids', () => {
  it('allows no opening information during an active Ranked game', () => {
    expect(ALL_ASSISTS).toContain('openingInfo');
    expect(allowed('ranked-active', 'openingInfo')).toBe(false);
    expect(allowed('ranked-finished', 'openingInfo')).toBe(true);
    expect(allowed('coach', 'openingInfo')).toBe(true);
  });
});
