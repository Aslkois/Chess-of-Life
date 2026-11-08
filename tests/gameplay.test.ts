import { Chess } from 'chess.js';
import { MAX_PAUSE_MS, RANGES, situation, sleep, thinkTime, type PaceInput } from '../src/engine/pacing';
import { AbortedError } from '../src/engine/controller';
import { addPremove, boardAfterPremoves, MAX_PREMOVES, premoveTargets, takePremove, validPremove } from '../src/chess/premove';
import { EMPTY_ANNOTATIONS, planColor, PLAN_COLORS, squareAt, toggleArrow, toggleMark } from '../src/ui/planning';
import { PEAK, soundForMove, synthesize, transitionSound } from '../src/audio/sounds';
import { mulberry32 } from '../src/util/rng';
import { res } from './helpers';

const START = new Chess().fen();
const after = (...sans: string[]) => { const c = new Chess(); for (const s of sans) c.move(s); return c.fen(); };
const pace = (p: Partial<PaceInput>) => thinkTime({ fen: START, uci: 'e2e4', level: 8, engineMs: 0, speed: 'natural', rand: mulberry32(1), ...p });

describe('opponent thinking time', () => {
  it('classifies forced, book, obvious, complicated and time-pressure moves', () => {
    expect(situation({ fen: '7k/8/8/8/8/8/6q1/7K w - - 0 1', uci: 'h1g2' })).toBe('forced');
    expect(situation({ fen: START, uci: 'e2e4', book: true })).toBe('book');
    const mate = '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1';
    expect(situation({ fen: mate, uci: 'a1a8', analysis: res(mate, [['Ra8#', { mate: 1 }], ['Kf1', { cp: 0 }]]) })).toBe('obvious');
    const loose = 'rnb1kbnr/pppp1ppp/8/4p1q1/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 0 1';
    expect(situation({ fen: loose, uci: 'c1g5', analysis: res(loose, [['Bxg5', { cp: 900 }], ['dxe5', { cp: 50 }]]) })).toBe('obvious');
    expect(situation({ fen: START, uci: 'e2e4', clockMs: 8000 })).toBe('pressure');
    const busy = 'r1bq1rk1/pp3ppp/2n1pn2/2bp4/2P5/2N1PN2/PPQ1BPPP/R1B2RK1 w - - 0 9';
    const lines = res(busy, [['cxd5', { cp: 20 }], ['a3', { cp: 15 }], ['b3', { cp: 12 }]]);
    expect(situation({ fen: busy, uci: 'c4d5', analysis: lines })).toBe('complex');
  });

  it('draws pauses from the documented ranges, with variation', () => {
    const seen = new Set<number>();
    for (let seed = 1; seed < 40; seed++) {
      const p = pace({ rand: mulberry32(seed), analysis: res(START, [['e4', { cp: 30 }]]) });
      expect(p.situation).toBe('normal');
      expect(p.targetMs).toBeGreaterThanOrEqual(RANGES.normal[0]);
      expect(p.targetMs).toBeLessThanOrEqual(RANGES.normal[1]);
      seen.add(p.targetMs);
    }
    expect(seen.size).toBeGreaterThan(20); // not one fixed delay
  });

  it('only waits for the part the engine did not already use', () => {
    const p1 = pace({ engineMs: 0, rand: mulberry32(5) });
    const p2 = pace({ engineMs: 400, rand: mulberry32(5) });
    expect(p2.targetMs).toBe(p1.targetMs);
    expect(p2.waitMs).toBe(Math.max(0, p1.targetMs - 400));
    expect(pace({ engineMs: 9000 }).waitMs).toBe(0); // a long search gets no extra delay
  });

  it('respects the speed setting without changing anything else', () => {
    expect(pace({ speed: 'instant' })).toMatchObject({ targetMs: 0, waitMs: 0 });
    const n = pace({ speed: 'natural', rand: mulberry32(9) }).targetMs;
    expect(pace({ speed: 'fast', rand: mulberry32(9) }).targetMs).toBeCloseTo(n * 0.5, -1);
    expect(pace({ speed: 'relaxed', rand: mulberry32(9) }).targetMs).toBeGreaterThan(n);
    for (let seed = 1; seed < 30; seed++) expect(pace({ speed: 'relaxed', rand: mulberry32(seed), fen: 'r1bq1rk1/pp3ppp/2n1pn2/2bp4/2P5/2N1PN2/PPQ1BPPP/R1B2RK1 w - - 0 9' }).targetMs).toBeLessThanOrEqual(MAX_PAUSE_MS * 1.6);
  });

  it('never risks the clock', () => {
    for (const clockMs of [600_000, 60_000, 12_000, 9_000, 4_000, 2_500]) {
      for (let seed = 1; seed < 20; seed++) {
        const p = pace({ clockMs, incrementMs: 0, rand: mulberry32(seed), speed: 'relaxed' });
        expect(p.targetMs).toBeLessThanOrEqual(Math.max(0, clockMs - 3000));
        expect(p.targetMs).toBeLessThanOrEqual(clockMs * 0.03 + 1);
      }
    }
    expect(pace({ clockMs: 2000 }).targetMs).toBe(0);
  });

  it('can be cancelled', async () => {
    vi.useFakeTimers();
    const ac = new AbortController();
    const p = sleep(5000, ac.signal);
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(AbortedError);
    const done = vi.fn();
    void sleep(800).then(done);
    await vi.advanceTimersByTimeAsync(799);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toHaveBeenCalled();
    vi.useRealTimers();
    await expect(sleep(10, AbortSignal.abort())).rejects.toBeInstanceOf(AbortedError);
  });
});

describe('premoves', () => {
  const afterE4 = after('e4'); // Black to move; White premoves
  it('accepts moves by movement pattern, ignoring pieces in the way', () => {
    const { board, castling } = boardAfterPremoves(afterE4, [], 'w');
    expect(premoveTargets(board, 'g1', 'w', castling).sort()).toEqual(['e2', 'f3', 'h3']);
    expect(premoveTargets(board, 'f1', 'w', castling)).toContain('a6'); // through its own pawn: it may have moved by then
    expect(premoveTargets(board, 'd2', 'w', castling).sort()).toEqual(['c3', 'd3', 'd4', 'e3']);
    expect(premoveTargets(board, 'e7', 'w', castling)).toEqual([]); // not your piece
    expect(validPremove(afterE4, [], { from: 'g1', to: 'g3' }, 'w')).toBeNull();
  });

  it('queues one premove (replacing) or up to five, on the board as it will be', () => {
    let q = addPremove(afterE4, [], { from: 'g1', to: 'f3' }, 'w', false)!;
    q = addPremove(afterE4, q, { from: 'b1', to: 'c3' }, 'w', false)!;
    expect(q).toEqual([{ from: 'b1', to: 'c3' }]); // replaced
    let m = addPremove(afterE4, [], { from: 'g1', to: 'f3' }, 'w', true)!;
    m = addPremove(afterE4, m, { from: 'f3', to: 'g5' }, 'w', true)!; // the knight is on f3 after the first premove
    expect(m).toHaveLength(2);
    for (const mv of [{ from: 'g5', to: 'f3' }, { from: 'f3', to: 'g5' }, { from: 'g5', to: 'f3' }]) m = addPremove(afterE4, m, mv, 'w', true) ?? m;
    expect(m).toHaveLength(MAX_PREMOVES);
    expect(addPremove(afterE4, m, { from: 'f3', to: 'g5' }, 'w', true)).toBeNull();
  });

  it('plays a premove only when it is legal, and cancels it otherwise', () => {
    const q = [{ from: 'g1', to: 'f3' }, { from: 'f1', to: 'c4' }];
    const r = takePremove(after('e4', 'e5'), q);
    expect(r).toEqual({ uci: 'g1f3', rest: [{ from: 'f1', to: 'c4' }] });
    // the second premove is checked again against the real position when its turn comes
    expect(takePremove(after('e4', 'e5', 'Nf3', 'Nc6'), [{ from: 'f1', to: 'c4' }])).toEqual({ uci: 'f1c4', rest: [] });
    // a premoved capture is played when the opponent's piece arrives there
    expect(takePremove(after('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'Nc3', 'Nd4'), [{ from: 'f3', to: 'd4' }])).toEqual({ uci: 'f3d4', rest: [] });
    // the opponent's move made it illegal: the pawn is blocked
    expect(takePremove(after('e4', 'e5'), [{ from: 'e4', to: 'e5' }])).toEqual({ cancelled: true });
    // the opponent's move put a piece in the way
    expect(validPremove('4k3/1r6/8/8/8/8/8/R3K3 b - - 0 1', [], { from: 'a1', to: 'a8' }, 'w')).not.toBeNull();
    expect(takePremove('4k3/r7/8/8/8/8/8/R3K3 w - - 1 2', [{ from: 'a1', to: 'a8' }])).toEqual({ cancelled: true }); // 1...Ra7 blocks the file
    expect(takePremove(after('e4'), [])).toBeNull();
  });

  it('handles castling and promotion premoves', () => {
    const fen = 'r3k2r/pppq1ppp/2n2n2/2bpp1B1/2B1P1b1/2NP1N2/PPPQ1PPP/R3K2R b KQkq - 0 1';
    expect(validPremove(fen, [], { from: 'e1', to: 'g1' }, 'w')).toEqual({ from: 'e1', to: 'g1' });
    expect(validPremove(fen, [], { from: 'e1', to: 'c1' }, 'w')).toEqual({ from: 'e1', to: 'c1' });
    const legalNow = fen.replace(' b ', ' w ');
    expect(takePremove(legalNow, [{ from: 'e1', to: 'g1' }])).toEqual({ uci: 'e1g1', rest: [] });
    const promo = '8/4P2k/8/8/8/8/7q/K7 b - - 0 1';
    expect(validPremove(promo, [], { from: 'e7', to: 'e8' }, 'w')).toEqual({ from: 'e7', to: 'e8', promotion: 'q' });
    expect(takePremove(promo.replace(' b ', ' w '), [{ from: 'e7', to: 'e8', promotion: 'q' }])).toEqual({ uci: 'e7e8q', rest: [] });
  });
});

describe('planning annotations', () => {
  it('toggles arrows and marked squares, and recolours them', () => {
    let a = toggleArrow(EMPTY_ANNOTATIONS, 'e2', 'e4', PLAN_COLORS.orange);
    a = toggleArrow(a, 'g1', 'f3', PLAN_COLORS.orange);
    expect(a.arrows).toHaveLength(2);
    a = toggleArrow(a, 'e2', 'e4', PLAN_COLORS.green);
    expect(a.arrows[0].color).toBe(PLAN_COLORS.green);
    a = toggleArrow(a, 'e2', 'e4', PLAN_COLORS.green);
    expect(a.arrows.map((x) => x.from)).toEqual(['g1']);
    a = toggleMark(a, 'd5', PLAN_COLORS.orange);
    expect(a.marks).toEqual([{ sq: 'd5', color: PLAN_COLORS.orange }]);
    expect(toggleMark(a, 'd5', PLAN_COLORS.orange).marks).toEqual([]);
  });
  it('picks colours from modifier keys', () => {
    expect(planColor({})).toBe(PLAN_COLORS.orange);
    expect(planColor({ shiftKey: true })).toBe(PLAN_COLORS.green);
    expect(planColor({ altKey: true })).toBe(PLAN_COLORS.blue);
    expect(planColor({ ctrlKey: true })).toBe(PLAN_COLORS.red);
  });
  it('maps pointer positions to squares in both orientations', () => {
    expect(squareAt(5, 5, 400, 'white')).toBe('a8');
    expect(squareAt(395, 395, 400, 'white')).toBe('h1');
    expect(squareAt(5, 5, 400, 'black')).toBe('h1');
    expect(squareAt(225, 175, 400, 'white')).toBe('e5');
    expect(squareAt(-1, 5, 400, 'white')).toBeNull();
  });
});

describe('move sounds', () => {
  const sound = (fen: string, san: string) => { const m = new Chess(fen).move(san); return soundForMove(m); };
  it('plays exactly one sound per move, by priority', () => {
    expect(sound(START, 'e4')).toBe('move');
    expect(sound(after('e4', 'd5'), 'exd5')).toBe('capture');
    expect(sound(after('e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6'), 'O-O')).toBe('castle');
    expect(sound(after('e4', 'e5', 'Bc4', 'Nc6'), 'Bxf7+')).toBe('check'); // capture with check: check wins
    expect(sound(after('f3', 'e5', 'g4'), 'Qh4#')).toBe('check');
    expect(sound(after('e4', 'd5', 'e5', 'f5'), 'exf6')).toBe('capture'); // en passant
    expect(sound('8/4P2k/8/8/8/8/8/K7 w - - 0 1', 'e8=Q')).toBe('move');
    expect(sound('r2k3r/8/8/8/8/8/8/R3K2R w KQ - 0 1', 'O-O-O')).toBe('check'); // castling with check (the rook lands on d1)
    expect(sound('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1', 'O-O-O')).toBe('castle');
  });
  it('recognises forward moves, single steps back, and ignores jumps', () => {
    expect(transitionSound(after('e4', 'd5'), after('e4', 'd5', 'exd5'))).toEqual({ kind: 'capture', direction: 'forward' });
    expect(transitionSound(after('e4', 'd5', 'exd5'), after('e4', 'd5'))).toEqual({ kind: 'move', direction: 'back' });
    expect(transitionSound(START, after('e4', 'e5'))).toBeNull();
    expect(transitionSound(START, START)).toBeNull();
  });
  it('synthesises crisp, unclipped and distinct sounds', () => {
    const lens: number[] = [];
    for (const k of ['move', 'capture', 'check', 'castle'] as const) {
      const d = synthesize(k, 44100);
      let peak = 0, energy = 0;
      for (const v of d) { peak = Math.max(peak, Math.abs(v)); energy += v * v; }
      expect(peak).toBeLessThanOrEqual(PEAK + 1e-6);
      expect(peak).toBeGreaterThan(0.5);
      expect(energy).toBeGreaterThan(10);
      expect(Math.abs(d[0])).toBeLessThan(0.05); // no click at the start
      expect(Math.abs(d[d.length - 1])).toBeLessThan(0.01); // nor at the end
      expect(d.length / 44100).toBeLessThan(0.5); // short and responsive
      lens.push(d.length);
    }
    expect(new Set(lens).size).toBe(4);
  });
});
