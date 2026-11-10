import { Chess } from 'chess.js';
import { gameFromMoves } from '../src/services/games';
import {
  completeLichessLogin, ExplorerError, explorerFen, fetchLichess, fetchMasters, fetchPlayer, getToken, lichessUrl, mastersUrl, normalise, playerUrl,
  resetClient, setFetch, setToken, startLichessLogin,
} from '../src/explorer/lichess';
import { DEFAULT_LOCAL, localExplorer, movesNotInDatabase } from '../src/explorer/local';
import { percentages, scoreFor } from '../src/explorer/types';
import type { GameRecord } from '../src/db/types';
import type { GameResult } from '../src/chess/rules';

// browser storage for the node test environment
class Mem { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } clear() { this.m.clear(); } }
(globalThis as unknown as { localStorage: Mem }).localStorage = new Mem();
(globalThis as unknown as { sessionStorage: Mem }).sessionStorage = new Mem();

const START = new Chess().fen();
const after = (...m: string[]) => { const c = new Chess(); for (const x of m) c.move(x); return c.fen(); };
/** A response in the documented OpeningExplorerMasters shape (test fixture only). */
const RAW = {
  opening: { eco: 'B00', name: "King's Pawn" }, white: 600, draws: 300, black: 100,
  moves: [
    { uci: 'e7e5', san: 'e5', averageRating: 2400, white: 300, draws: 150, black: 50, game: null, opening: null },
    { uci: 'c7c5', san: 'c5', averageRating: 2420, white: 200, draws: 100, black: 50, game: null, opening: { eco: 'B20', name: 'Sicilian Defense' } },
  ],
  topGames: [{ uci: 'c7c5', id: 'abc12345', winner: 'black', white: { name: 'Carlsen, M.', rating: 2850 }, black: { name: 'Nakamura, H.', rating: 2790 }, year: 2019, month: '2019-03' }],
};
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

beforeEach(() => { resetClient(); localStorage.clear(); sessionStorage.clear(); });

describe('Lichess explorer client', () => {
  it('normalises the documented response and computes percentages', () => {
    const r = normalise('masters', RAW as never, 30);
    expect(r.moves.map((m) => [m.san, m.white + m.draws + m.black])).toEqual([['e5', 500], ['c5', 350]]);
    expect(r.topGames[0]).toMatchObject({ id: 'abc12345', source: 'masters', winner: 'black', white: { name: 'Carlsen, M.', rating: 2850 }, year: 2019 });
    expect(percentages(r)).toEqual({ white: 60, draws: 30, black: 10 });
    expect(scoreFor(r.moves[0], 'b')).toBeCloseTo((50 + 75) / 500);
    expect(percentages({ white: 0, draws: 0, black: 0 })).toEqual({ white: 0, draws: 0, black: 0 });
    expect(() => normalise('masters', { nope: 1 } as never, 30)).toThrow(ExplorerError);
  });

  it('asks for transposition-safe positions and passes the filters', () => {
    // 1.e4: the en passant square is not legal, so it is left out
    expect(explorerFen(after('e4'))).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1');
    expect(explorerFen(after('Nf3', 'Nf6', 'd4', 'd5'))).toBe(explorerFen(after('d4', 'd5', 'Nf3', 'Nf6')));
    const u = new URL(lichessUrl(START, { speeds: ['blitz', 'rapid'], ratings: [2000, 2200], since: '2020-01', until: '2023-12' }));
    expect(u.host).toBe('explorer.lichess.org');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ speeds: 'blitz,rapid', ratings: '2000,2200', since: '2020-01', until: '2023-12', variant: 'standard' });
    expect(new URL(mastersUrl(START, { since: 1990, until: 2000 })).searchParams.get('since')).toBe('1990');
    expect(Object.fromEntries(new URL(playerUrl(START, { name: 'revoof', color: 'black', speeds: [], modes: ['rated'] })).searchParams)).toMatchObject({ player: 'revoof', color: 'black', modes: 'rated' });
  });

  it('needs a token, sends it as a bearer token, and reports a rejected one', async () => {
    const calls: RequestInit[] = [];
    setFetch(async (_u, i) => { calls.push(i!); return json({}, 401); });
    await expect(fetchMasters(START, {})).rejects.toMatchObject({ kind: 'auth' });
    expect(calls).toHaveLength(0); // nothing is sent without a token
    setToken('lip_abcdefgh123');
    await expect(fetchMasters(START, {})).rejects.toMatchObject({ kind: 'auth' });
    expect((calls[0].headers as Record<string, string>).Authorization).toBe('Bearer lip_abcdefgh123');
  });

  it('respects the rate limit: after a 429 it waits a minute and does not call again', async () => {
    setToken('lip_abcdefgh123');
    let n = 0;
    setFetch(async () => { n++; return json({}, 429); });
    await expect(fetchMasters(START, {})).rejects.toMatchObject({ kind: 'rate' });
    await expect(fetchLichess(START, { speeds: [], ratings: [] })).rejects.toMatchObject({ kind: 'rate' });
    expect(n).toBe(1);
  });

  it('makes one request at a time', async () => {
    setToken('lip_abcdefgh123');
    let active = 0, peak = 0;
    setFetch(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 15)); active--; return json(RAW); });
    await Promise.all([fetchMasters(START, {}), fetchMasters(after('e4'), {}), fetchMasters(after('d4'), {})]);
    expect(peak).toBe(1);
  });

  it('caches answers and serves them when Lichess cannot be reached', async () => {
    setToken('lip_abcdefgh123');
    let n = 0;
    setFetch(async () => { n++; return json(RAW); });
    const a = await fetchMasters(after('e4'), {});
    const b = await fetchMasters(after('e4'), {});
    expect(n).toBe(1);
    expect(b.fromCache).toBe(true);
    expect(b.moves).toEqual(a.moves);
    resetClient(); // new session: memory cache gone, the stored copy remains
    setFetch(async () => { throw new TypeError('network down'); });
    const c = await fetchMasters(after('e4'), {});
    expect(c.fromCache).toBe(true);
    await expect(fetchMasters(after('d4'), {})).rejects.toMatchObject({ kind: 'offline' });
  });

  it('reads the player explorer stream (last line) and does not cache while indexing', async () => {
    setToken('lip_abcdefgh123');
    const first = { ...RAW, queuePosition: 3 };
    const done = { ...RAW, queuePosition: 0 };
    let n = 0;
    setFetch(async () => { n++; return new Response(`${JSON.stringify(first)}\n${JSON.stringify(n === 1 ? first : done)}\n`); });
    const r1 = await fetchPlayer(START, { name: 'revoof', color: 'white', speeds: [], modes: [] });
    expect(r1.queuePosition).toBe(3);
    const r2 = await fetchPlayer(START, { name: 'revoof', color: 'white', speeds: [], modes: [] });
    expect(n).toBe(2);
    expect(r2.queuePosition).toBe(0);
    await expect(fetchPlayer(START, { name: '', color: 'white', speeds: [], modes: [] })).rejects.toBeInstanceOf(ExplorerError);
  });

  it('logs in with Lichess using the authorization code flow with PKCE', async () => {
    const url = new URL(await startLichessLogin('https://example.org/app/'));
    expect(url.origin + url.pathname).toBe('https://lichess.org/oauth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('response_type')).toBe('code');
    const state = url.searchParams.get('state')!;
    const posted: string[] = [];
    setFetch(async (u, i) => {
      if (u.endsWith('/api/token')) { posted.push(String(i?.body)); return json({ access_token: 'lio_token123456', token_type: 'Bearer' }); }
      if (u.endsWith('/api/account')) return json({ username: 'Tester' });
      return json({}, 404);
    });
    await expect(completeLichessLogin('?code=abc&state=wrong')).rejects.toMatchObject({ kind: 'auth' });
    await startLichessLogin('https://example.org/app/');
    const state2 = JSON.parse(sessionStorage.getItem('col.lichess.pkce')!).state;
    expect(state2).not.toBe(state);
    expect(await completeLichessLogin(`?code=abc&state=${state2}`)).toBe('Tester');
    expect(posted[0]).toMatch(/grant_type=authorization_code/);
    expect(posted[0]).toMatch(/code_verifier=/);
    expect(getToken()).toBe('lio_token123456');
  });
});

let n = 0;
function g(moves: string, result: GameResult, white = 'A', black = 'B', extra: Partial<GameRecord> = {}): GameRecord {
  const r = gameFromMoves('pgn', moves.split(' '), { White: white, Black: black, Date: `2024.0${(n % 9) + 1}.01`, Result: result }, result);
  r.id = `g${n++}`;
  return { ...r, ...extra };
}

describe('My Games database', () => {
  const games = [
    g('e4 e5 Nf3 Nc6', '1-0', 'alice', 'bob'),
    g('e4 e5 Nf3 Nf6', '0-1', 'carol', 'alice'),
    g('e4 c5 Nf3 d6', '1/2-1/2', 'alice', 'dave'),
    g('Nf3 e5 e4', '1-0', 'erin', 'alice'), // transposes to 1.e4 e5 2.Nf3
    g('e4 e5 Nf3', '*', 'x', 'y'), // unfinished: no result to count
  ];
  it('counts results per move from both sides, by position', () => {
    const r = localExplorer(games, after('e4', 'e5', 'Nf3'), DEFAULT_LOCAL);
    expect([r.white, r.draws, r.black]).toEqual([2, 0, 1]);
    expect(r.moves.map((m) => [m.san, m.white, m.draws, m.black])).toEqual([['Nc6', 1, 0, 0], ['Nf6', 0, 0, 1]]);
    expect(r.recentGames).toHaveLength(3); // including the transposition, which ended there
    const start = localExplorer(games, START, DEFAULT_LOCAL);
    expect(start.moves.map((m) => [m.san, m.white + m.draws + m.black])).toEqual([['e4', 3], ['Nf3', 1]]);
  });
  it('filters by player and colour, and by your own side', () => {
    const asBlack = localExplorer(games, START, { ...DEFAULT_LOCAL, player: 'Alice', playerColor: 'b' });
    expect(asBlack.white + asBlack.draws + asBlack.black).toBe(2);
    const mine = localExplorer(games, START, { ...DEFAULT_LOCAL, as: 'w' }, ['alice']);
    expect(mine.white + mine.draws + mine.black).toBe(2);
    expect(localExplorer(games, after('a4'), DEFAULT_LOCAL).moves).toEqual([]);
  });
  it('lists legal moves the database has no games for', () => {
    const r = localExplorer(games, after('e4', 'e5', 'Nf3'), DEFAULT_LOCAL);
    const missing = movesNotInDatabase(after('e4', 'e5', 'Nf3'), r.moves.map((m) => m.uci));
    expect(missing.length).toBe(new Chess(after('e4', 'e5', 'Nf3')).moves().length - 2);
    expect(missing.map((m) => m.san)).not.toContain('Nc6');
  });
});
