import 'fake-indexeddb/auto';
import { all, closeDb, deleteAllData, exportAll, get, getPrefs, importBackup, listGames, persistentAnalysisCache, put, setPrefs, deleteGame } from '../src/db/db';
import { gameFromMoves, saveGame, saveTree, gamePgn, queueTreeSave } from '../src/services/games';
import { addMove, mainline } from '../src/chess/tree';

describe('IndexedDB persistence', () => {
  beforeEach(async () => { await deleteAllData(); });

  it('saves games and their branches, surviving a reconnect', async () => {
    const g = gameFromMoves('manual', ['e4', 'e5', 'Nf3'], { White: 'Me', Black: 'You' }, '*');
    await saveGame(g);
    const r = addMove(g.tree, mainline(g.tree)[2], 'Bc4', 'user');
    await saveTree(g.id, r.tree);
    await closeDb(); // simulate an app restart
    const games = await listGames();
    expect(games).toHaveLength(1);
    expect(games[0].moves).toEqual(['e4', 'e5', 'Nf3']);
    expect(games[0].tree.nodes[r.nodeId].san).toBe('Bc4');
    expect(mainline(games[0].tree).length).toBe(4);
    const pgn = await gamePgn(games[0]);
    expect(pgn).toContain('(2. Bc4');
    await deleteGame(g.id);
    expect(await listGames()).toHaveLength(0);
  });

  it('keeps rapid successive branch edits in order (no lost writes)', async () => {
    const g = gameFromMoves('manual', ['e4', 'e5', 'Nf3'], {}, '*');
    await saveGame(g);
    let tree = g.tree;
    let at = mainline(tree)[3];
    const saves: Promise<void>[] = [];
    for (const mv of ['Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6']) {
      const r = addMove(tree, at, mv, 'user');
      tree = r.tree; at = r.nodeId;
      saves.push(queueTreeSave(g.id, tree)); // fire without awaiting, like UI clicks
    }
    await Promise.all(saves);
    await closeDb();
    const stored = (await listGames())[0];
    expect(Object.keys(stored.tree.nodes)).toHaveLength(Object.keys(tree.nodes).length);
    expect(stored.tree.nodes[at].san).toBe('Nf6');
  });

  it('stores drafts, preferences and engine cache entries', async () => {
    await put('drafts', { id: 'current', moves: ['d4', 'd5'], cursor: 1, orientation: 'black', headers: {}, startFen: 'x', updatedAt: 1 });
    expect((await get('drafts', 'current'))?.cursor).toBe(1);
    const prefs = await getPrefs();
    expect(prefs.deepDepth).toBe(16);
    await setPrefs({ ...prefs, deepDepth: 20 });
    expect((await getPrefs()).deepDepth).toBe(20);
    await persistentAnalysisCache.set('k', { fen: 'f', key: 'k', depth: 12, lines: [], bestmove: null });
    expect((await persistentAnalysisCache.get('k'))?.depth).toBe(12);
  });

  it('exports, deletes and re-imports a full backup', async () => {
    await saveGame(gameFromMoves('pgn', ['e4'], {}, '1-0'));
    await put('profiles', { id: 'ranked', rating: { r: 1300, rd: 100, vol: 0.06 }, history: [], wins: 1, draws: 0, losses: 0 });
    const backup = JSON.parse(JSON.stringify(await exportAll()));
    expect(backup.app).toBe('chess-of-life');
    await deleteAllData();
    expect(await all('games')).toHaveLength(0);
    const rep = await importBackup(backup);
    expect(rep.imported.games).toBe(1);
    expect(((await get('profiles', 'ranked')) as { wins: number }).wins).toBe(1);
    await expect(importBackup({ hello: 1 })).rejects.toThrow(/not a Chess of Life backup/);
  });
});
