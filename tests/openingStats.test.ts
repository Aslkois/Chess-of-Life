import { Chess } from 'chess.js';
import { gameFromMoves } from '../src/services/games';
import { buildOpeningTree, byMonth, gamesAtPosition, gameOpeningStat, openingStats, playerColorOf, scoreFor } from '../src/services/openings';
import { fensOf } from '../src/analysis/openings';
import type { GameRecord, GameSource, StoredReview } from '../src/db/types';
import type { GameResult } from '../src/chess/rules';

const NAJDORF = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6', 'Be3', 'e5'];
const DRAGON = ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'g6'];
const ITALIAN = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3', 'Nf6'];
const KID_VIA_ENGLISH = ['c4', 'g6', 'Nc3', 'Bg7', 'd4', 'Nf6', 'e4', 'd6'];
const KID = ['d4', 'Nf6', 'c4', 'g6', 'Nc3', 'Bg7', 'e4', 'd6'];

let n = 0;
function game(source: GameSource, moves: string[], result: GameResult, white: string, black: string, extra: Partial<GameRecord> = {}): GameRecord {
  const g = gameFromMoves(source, moves, { White: white, Black: black, Date: `2026.0${(n % 3) + 1}.1${n % 9}`, Result: result }, result);
  g.id = `g${n++}`;
  return { ...g, ...extra };
}

describe('whose game is it', () => {
  it('knows the side in Coach and Ranked games, and in imported games only when established', () => {
    expect(playerColorOf({ source: 'coach', headers: { White: 'You', Black: 'Coach (level 5)' } })).toBe('w');
    expect(playerColorOf({ source: 'ranked', headers: { White: 'Rival (level 9)', Black: 'You' } })).toBe('b');
    expect(playerColorOf({ source: 'pgn', headers: { White: 'Carlsen', Black: 'Nepo' } })).toBeUndefined();
    expect(playerColorOf({ source: 'pgn', headers: { White: 'Carlsen', Black: 'alice99' } }, ['Alice99'])).toBe('b');
    expect(playerColorOf({ source: 'pgn', headers: { White: 'alice99', Black: 'alice99' } }, ['alice99'])).toBeUndefined(); // ambiguous
    expect(playerColorOf({ source: 'manual', headers: { White: '?', Black: '?' }, playerColor: 'w' })).toBe('w');
    expect(playerColorOf({ source: 'pgn', headers: { White: 'alice99', Black: 'x' }, playerColor: null }, ['alice99'])).toBeNull(); // explicitly not mine
  });
  it('scores results from the user’s side', () => {
    expect([scoreFor('1-0', 'w'), scoreFor('1-0', 'b'), scoreFor('1/2-1/2', 'b'), scoreFor('*', 'w')]).toEqual([1, 0, 0.5, null]);
  });
});

describe('My Games at a position (Opening Explorer)', () => {
  const games = [
    game('ranked', NAJDORF, '1-0', 'You', 'Rival'),
    game('ranked', DRAGON, '0-1', 'You', 'Rival'),
    game('pgn', NAJDORF, '1/2-1/2', 'alice99', 'bob'),
    game('pgn', NAJDORF, '1-0', 'Carlsen', 'Nepo'), // not the user's: side unknown
    game('coach', NAJDORF, '1-0', 'You', 'Coach'),
    game('pgn', KID_VIA_ENGLISH, '0-1', 'x', 'alice99'),
  ];
  const sicilianAfterNc3 = fensOf(NAJDORF.slice(0, 9)).at(-1)!;

  it('counts each game once, only with a known side, Coach games apart', () => {
    const s = gamesAtPosition(games, sicilianAfterNc3, ['alice99']);
    expect(s.games.map((g) => g.game.id)).toEqual(expect.arrayContaining(['g0', 'g1', 'g2']));
    expect(s.games).toHaveLength(3);
    expect(s.unknownSide).toBe(1); // Carlsen–Nepo reaches it but is not counted
    expect(s.moves.map((m) => [m.san, m.games, m.w, m.d, m.l])).toEqual([['a6', 2, 1, 1, 0], ['g6', 1, 0, 0, 1]]);
    const coach = gamesAtPosition(games, sicilianAfterNc3, ['alice99'], { source: 'coach', color: 'both' });
    expect(coach.games.map((g) => g.game.id)).toEqual(['g4']);
  });

  it('finds games by position, so transpositions count', () => {
    const kidFen = fensOf(KID).at(-1)!;
    const s = gamesAtPosition(games, kidFen, ['alice99']);
    expect(s.games.map((g) => g.game.id)).toEqual(['g5']);
    expect(s.games[0].ply).toBe(8);
    expect(s.games[0].next).toBeNull();
  });

  it('filters by colour', () => {
    const start = new Chess().fen();
    const asBlack = gamesAtPosition(games, start, ['alice99'], { source: 'competitive', color: 'b' });
    expect(asBlack.games.map((g) => g.game.id)).toEqual(['g5']);
  });
});

describe('personal opening statistics', () => {
  const review = (g: GameRecord, clsAt: Record<number, string>): StoredReview => ({
    gameId: g.id, status: 'complete', moves: g.moves.map((san, ply) => ({ ply, san, color: ply % 2 === 0 ? 'w' : 'b', cls: clsAt[ply] ?? 'best', accuracy: clsAt[ply] ? 40 : 100, forced: false })),
  } as unknown as StoredReview);

  it('groups by family, variation and sub-variation without double counting', () => {
    const games = [
      game('ranked', NAJDORF, '1-0', 'You', 'Rival'),
      game('ranked', [...NAJDORF.slice(0, 10), 'Bg5'], '0-1', 'You', 'Rival'),
      game('ranked', DRAGON, '1/2-1/2', 'Rival', 'You'),
      game('ranked', ITALIAN, '1-0', 'You', 'Rival'),
    ];
    const r = openingStats(games, new Map(), [], { source: 'competitive', color: 'both' });
    expect(r.counted).toHaveLength(4);
    const sic = r.tree.find((f) => f.label === 'Sicilian Defense')!;
    expect(sic.games).toHaveLength(3);
    expect([sic.w, sic.d, sic.l]).toEqual([1, 1, 1]);
    expect(sic.scorePct).toBeCloseTo(50);
    const naj = sic.children.find((c) => c.label === 'Najdorf Variation')!;
    expect(naj.games).toHaveLength(2);
    // the sum over variations never exceeds the family count
    expect(sic.children.reduce((s, c) => s + c.games.length, 0)).toBeLessThanOrEqual(sic.games.length);
    expect(r.tree.find((f) => f.label === 'Italian Game')!.games).toHaveLength(1);
  });

  it('excludes games without an established side and keeps Coach games apart', () => {
    const games = [
      game('pgn', NAJDORF, '1-0', 'Carlsen', 'Nepo'),
      game('coach', ITALIAN, '1-0', 'You', 'Coach'),
      game('manual', ITALIAN, '0-1', '?', '?', { playerColor: 'b' }),
    ];
    const comp = openingStats(games, new Map(), [], { source: 'competitive', color: 'both' });
    expect(comp.counted.map((c) => c.gameId)).toEqual([games[2].id]);
    expect(comp.unknownSide).toBe(1);
    const coach = openingStats(games, new Map(), [], { source: 'coach', color: 'both' });
    expect(coach.counted.map((c) => c.gameId)).toEqual([games[1].id]);
  });

  it('measures opening-phase accuracy and early errors from the review, and who left theory', () => {
    const g = game('ranked', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Kf1', 'Nf6'], '0-1', 'You', 'Rival');
    const s = gameOpeningStat(g, review(g, { 6: 'mistake', 7: 'blunder' }), [])!;
    expect(s.opening.name).toBe('Italian Game: Giuoco Piano');
    expect(s.exit).toEqual({ ply: 6, san: 'Kf1', byUser: true });
    expect(s.earlyErrors).toBe(1); // only the user's own moves count
    expect(s.openingAccuracy).toBeCloseTo((3 * 100 + 40) / 4);
    const noReview = gameOpeningStat(g, undefined, [])!;
    expect(noReview.openingAccuracy).toBeNull();
    expect(noReview.earlyErrors).toBeNull();
    const tree = buildOpeningTree([s]);
    expect(tree[0].exits[0]).toEqual({ san: '4.Kf1', byUser: true, games: 1 });
    expect(tree[0].userExits).toBe(1);
  });

  it('reports results over time by month', () => {
    const games = [game('ranked', ITALIAN, '1-0', 'You', 'R'), game('ranked', ITALIAN, '0-1', 'You', 'R')];
    const r = openingStats(games, new Map(), [], { source: 'competitive', color: 'both' });
    const months = byMonth(r.counted);
    expect(months.reduce((s, m) => s + m.games, 0)).toBe(2);
  });
});
