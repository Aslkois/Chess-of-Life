import { AbortedError, EngineController } from '../src/engine/controller';
import { createMockTransport } from './mockEngine';
import { createNodeTransport } from './nodeTransport';
import { START_FEN } from '../src/chess/tree';

const FEN_B = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';

describe('EngineController (scripted engine)', () => {
  it('runs a search, normalises scores and caches by position', async () => {
    const t = createMockTransport();
    const e = new EngineController(() => t);
    const r = await e.analyze({ fen: FEN_B, depth: 6, multipv: 2 });
    expect(r.depth).toBe(6);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[0].score).toEqual({ cp: -10 }); // black to move: +10 for black = -10 for White
    expect(r.bestmove).toBe('e7e5');
    const gos = t.log.filter((l) => l.startsWith('go')).length;
    // same position with different move counters is a cache hit
    const again = await e.analyze({ fen: FEN_B.replace(' 0 1', ' 4 9'), depth: 5, multipv: 2 });
    expect(again.fromCache).toBe(true);
    // a lower multipv request is answered from the higher multipv result
    const lower = await e.analyze({ fen: FEN_B, depth: 6, multipv: 1 });
    expect(lower.fromCache).toBe(true);
    expect(lower.lines).toHaveLength(1);
    expect(t.log.filter((l) => l.startsWith('go')).length).toBe(gos);
    e.dispose();
  });

  it('cancels a running search and rejects stale output', async () => {
    const t = createMockTransport({ delayMs: 200 });
    const e = new EngineController(() => t);
    const ac = new AbortController();
    const p1 = e.analyze({ fen: START_FEN, depth: 8, signal: ac.signal });
    const p2 = e.analyze({ fen: FEN_B, depth: 4 });
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await expect(p1).rejects.toBeInstanceOf(AbortedError);
    const r2 = await p2;
    // the stale "h2h4 / cp 999" line emitted during stop must not leak into the next search
    expect(r2.bestmove).toBe('e7e5');
    expect(r2.lines.every((l) => l.pv[0] !== 'h2h4')).toBe(true);
    e.dispose();
  });

  it('cancels queued searches without touching the engine', async () => {
    const t = createMockTransport({ delayMs: 50 });
    const e = new EngineController(() => t);
    const p1 = e.analyze({ fen: START_FEN, depth: 3 });
    const ac = new AbortController();
    const p2 = e.analyze({ fen: FEN_B, depth: 3, signal: ac.signal });
    ac.abort();
    await expect(p2).rejects.toBeInstanceOf(AbortedError);
    await p1;
    expect(t.log.filter((l) => l.startsWith('position')).length).toBe(1);
    e.dispose();
  });

  it('lets an interactive request preempt background analysis, then resumes it', async () => {
    const t = createMockTransport({ delayMs: 150 });
    const e = new EngineController(() => t);
    const order: string[] = [];
    const bg = e.analyze({ fen: START_FEN, depth: 5, priority: 0 }).then((r) => { order.push('bg'); return r; });
    await new Promise((r) => setTimeout(r, 20));
    const fg = e.analyze({ fen: FEN_B, depth: 5, priority: 2 }).then((r) => { order.push('fg'); return r; });
    const [rb, rf] = await Promise.all([bg, fg]);
    expect(order).toEqual(['fg', 'bg']);
    expect(rb.bestmove).toBe('e2e4');
    expect(rf.bestmove).toBe('e7e5');
    e.dispose();
  });

  it('restarts after an engine crash and retries the search', async () => {
    let made = 0;
    const e = new EngineController(() => { made++; return createMockTransport({ failOnGo: made === 1 ? 1 : undefined }); });
    const r = await e.analyze({ fen: START_FEN, depth: 3 });
    expect(r.bestmove).toBe('e2e4');
    expect(made).toBe(2);
    expect(e.status.restarts).toBe(1);
    e.dispose();
  });

  it('answers terminal positions without the engine', async () => {
    const e = new EngineController(() => { throw new Error('should not start'); });
    const mate = await e.analyze({ fen: 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3' });
    expect(mate.terminal).toBe('checkmate');
    expect(mate.lines[0].score).toEqual({ mated: 'w' });
    const stale = await e.analyze({ fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' });
    expect(stale.terminal).toBe('stalemate');
    expect(stale.lines[0].score).toEqual({ cp: 0 });
  });
});

describe('EngineController (real Stockfish WASM)', () => {
  it('finds a mate in one and reports it from White’s point of view', async () => {
    const e = new EngineController(createNodeTransport);
    // Black to move, Qh4# is mate: score must be negative mate (Black mates)
    const r = await e.analyze({ fen: 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2', depth: 8, multipv: 2 });
    expect(r.bestmove).toBe('d8h4');
    expect(r.lines[0].score.mate).toBe(-1);
    expect(r.lines).toHaveLength(2);
    e.dispose();
  });
});
