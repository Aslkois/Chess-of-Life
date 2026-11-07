import { Chess } from 'chess.js';
import { bandFor, classifyMove, outcomeBand, type MoveContext, type SacrificeCheck } from '../src/analysis/classify';
import { EngineController } from '../src/engine/controller';
import { reviewGame } from '../src/analysis/review';
import { createTree, addMove, treeFromMoves } from '../src/chess/tree';
import { verifySacrifice } from '../src/analysis/verify';
import { createNodeTransport } from './nodeTransport';
import { after, res, uci } from './helpers';

type S = { cp?: number; mate?: number };
function ctx(fen: string, played: string, lines: [string, S][], afterScore: S, extra: Partial<MoveContext> = {}): MoveContext {
  const fa = after(fen, played);
  const c = new Chess(fen);
  const term = new Chess(fa).moves().length === 0;
  return {
    fenBefore: fen, uci: uci(fen, played), color: c.turn(), before: res(fen, lines),
    after: term ? { ...res(fa, []), lines: [{ multipv: 1, depth: 999, score: afterScore, pv: [] }], depth: 999 } : res(fa, [[new Chess(fa).moves()[0], afterScore]]),
    legalMoves: c.moves().length, targetDepth: 16, ...extra,
  };
}
const chk = (acceptWin: number, real = true, acceptUci = 'x'): SacrificeCheck => ({ acceptUci, acceptWin, depth: 16, real });

const SCANDI = 'rnb1kbnr/ppp1pppp/2q5/8/8/2N5/PPPP1PPP/R1BQKBNR w KQkq - 2 4';
const GREEK = 'r1bq1rk1/pppnnppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R1BQK2R w KQ - 0 8';
const MID = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

describe('expected-points bands (Chess.com V2 limits, inclusive upper bounds)', () => {
  it('places boundary values in the documented band', () => {
    expect(bandFor(0)).toBe('best');
    expect(bandFor(0.05)).toBe('best');
    expect(bandFor(0.06)).toBe('excellent');
    expect(bandFor(2)).toBe('excellent');
    expect(bandFor(2.001)).toBe('good');
    expect(bandFor(5)).toBe('good');
    expect(bandFor(5.01)).toBe('inaccuracy');
    expect(bandFor(10)).toBe('inaccuracy');
    expect(bandFor(10.01)).toBe('mistake');
    expect(bandFor(20)).toBe('mistake');
    expect(bandFor(20.01)).toBe('blunder');
    expect(bandFor(100)).toBe('blunder');
  });
  it('maps winning chances to outcome bands', () => {
    expect([5, 25, 50, 70, 90].map(outcomeBand)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('Brilliant requires a real, sound, meaningful sacrifice', () => {
  it('Scandinavian 4.Bb5 is not a sacrifice (Qxb5 loses the queen to Nxb5)', () => {
    const r = classifyMove(ctx(SCANDI, 'Bb5', [['Bb5', { cp: 460 }], ['d4', { cp: 104 }]], { cp: 460 }));
    expect(r.sacrifice).toBe(0);
    expect(r.acceptances).toEqual([]);
    expect(r.needsSacrificeCheck).toBe(false);
    expect(r.cls).not.toBe('brilliant');
    // it is the only move that exploits 3...Qc6: Great, not Brilliant
    expect(r.cls).toBe('great');
  });

  it('awards a sound piece sacrifice that the opponent can reasonably accept (Greek gift)', () => {
    const c = ctx(GREEK, 'Bxh7+', [['Bxh7+', { cp: 260 }], ['O-O', { cp: 118 }]], { cp: 260 });
    const unverified = classifyMove(c);
    expect(unverified.sacrifice).toBeGreaterThanOrEqual(2);
    expect(unverified.acceptances).toContain('g8h7');
    expect(unverified.needsSacrificeCheck).toBe(true);
    expect(unverified.cls).not.toBe('brilliant'); // never without verification
    expect(classifyMove({ ...c, sacrificeCheck: chk(82, true, 'Kxh7') }).cls).toBe('brilliant');
  });

  it('rejects an unsound sacrifice (accepting refutes it)', () => {
    const c = ctx(GREEK, 'Bxh7+', [['Bxh7+', { cp: -20 }], ['O-O', { cp: -30 }]], { cp: -20 });
    expect(classifyMove({ ...c, sacrificeCheck: chk(30, true, 'Kxh7') }).cls).not.toBe('brilliant');
  });

  it('rejects a trap: taking the material is a blunder the opponent can simply avoid', () => {
    const c = ctx(GREEK, 'Bxh7+', [['Bxh7+', { cp: 150 }], ['O-O', { cp: 110 }]], { cp: 150 });
    const r = classifyMove({ ...c, sacrificeCheck: chk(100, true, 'Kxh7') });
    expect(r.cls).not.toBe('brilliant');
    expect(r.notes.join(' ')).toMatch(/trap/);
  });

  it('rejects material that comes straight back (no real sacrifice)', () => {
    const c = ctx(GREEK, 'Bxh7+', [['Bxh7+', { cp: 260 }], ['O-O', { cp: 118 }]], { cp: 260 });
    const r = classifyMove({ ...c, sacrificeCheck: chk(80, false) });
    expect(r.cls).not.toBe('brilliant');
    expect(r.notes.join(' ')).toMatch(/comes straight back/);
    expect(classifyMove({ ...c, sacrificeCheck: null }).cls).not.toBe('brilliant');
  });

  it('accepts positional compensation: an exchange sacrifice with no immediate material return', () => {
    const fen = '2r1k3/pp3ppp/8/8/8/2N5/PP3PPP/4K3 b - - 0 1';
    const c = ctx(fen, 'Rxc3', [['Rxc3', { cp: -40 }], ['a6', { cp: 10 }]], { cp: -40 });
    const r0 = classifyMove(c);
    expect(r0.sacrifice).toBe(2); // rook for knight
    expect(classifyMove({ ...c, sacrificeCheck: chk(55, true, 'bxc3') }).cls).toBe('brilliant');
  });

  it('does not award Brilliant when the player was completely winning anyway', () => {
    const c = ctx(GREEK, 'Bxh7+', [['Bxh7+', { cp: 900 }], ['O-O', { cp: 700 }]], { cp: 900 });
    const r = classifyMove({ ...c, sacrificeCheck: chk(97, true, 'Kxh7') });
    expect(r.cls).not.toBe('brilliant');
    expect(r.notes.join(' ')).toMatch(/already completely winning/);
  });

  it('assumes nothing when alternatives are unknown: a winning sacrifice without MultiPV is not Brilliant', () => {
    const c = ctx(GREEK, 'Bxh7+', [['Bxh7+', { cp: 900 }]], { cp: 900 });
    expect(classifyMove({ ...c, sacrificeCheck: chk(97) }).cls).not.toBe('brilliant');
  });

  it('requires the best or nearly best move', () => {
    const c = ctx(GREEK, 'Bxh7+', [['O-O', { cp: 200 }], ['Bxh7+', { cp: 100 }]], { cp: 100 });
    expect(classifyMove({ ...c, sacrificeCheck: chk(70) }).cls).not.toBe('brilliant');
  });

  it('never awards Brilliant or Great on provisional (shallow) analysis', () => {
    const c = ctx(GREEK, 'Bxh7+', [['Bxh7+', { cp: 260 }], ['O-O', { cp: 118 }]], { cp: 260 });
    c.before.depth = 8; c.after.depth = 8;
    const r = classifyMove({ ...c, sacrificeCheck: chk(82) });
    expect(r.provisional).toBe(true);
    expect(r.cls).toBe('best');
    const g = ctx(SCANDI, 'Bb5', [['Bb5', { cp: 460 }], ['d4', { cp: 104 }]], { cp: 460 });
    g.before.depth = 8; g.after.depth = 8;
    expect(classifyMove(g).cls).toBe('best');
  });
});

describe('Great requires a critical, non-routine decision', () => {
  it('finds a defensive resource that keeps a balanced game', () => {
    const r = classifyMove(ctx(MID, 'd3', [['d3', { cp: 0 }], ['Nc3', { cp: -320 }]], { cp: 0 }));
    expect(r.cls).toBe('great');
    expect(r.notes.join(' ')).toMatch(/only move/);
  });
  it('is not awarded for a large gap that does not change the outcome', () => {
    expect(classifyMove(ctx(MID, 'd3', [['d3', { cp: 1200 }], ['Nc3', { cp: 700 }]], { cp: 1200 })).cls).toBe('best');
    expect(classifyMove(ctx(MID, 'd3', [['d3', { cp: 20 }], ['Nc3', { cp: -20 }]], { cp: 20 })).cls).toBe('best');
  });
  it('rewards turning a balanced game into a winning one after an opponent mistake', () => {
    const r = classifyMove(ctx(MID, 'd3', [['d3', { cp: 400 }], ['Nc3', { cp: 200 }]], { cp: 400 }, { prevOpponentEpl: 25, moverWinBeforeOpponentMove: 50 }));
    expect(r.cls).toBe('great');
    expect(r.notes.join(' ')).toMatch(/balanced game into a winning one/);
  });
  it('is not awarded for routine captures of a piece that was just left en prise', () => {
    const fen = '4k3/8/8/3q4/8/2N5/8/4K3 w - - 0 1';
    expect(classifyMove(ctx(fen, 'Nxd5', [['Nxd5', { cp: 900 }], ['Kf1', { cp: -900 }]], { cp: 900 }, { prevUci: 'd8d5' })).cls).toBe('best');
  });
  it('is not awarded for delivering mate in one', () => {
    const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
    expect(classifyMove(ctx(fen, 'Ra8#', [['Ra8#', { mate: 1 }], ['Kf1', { cp: 0 }]], { mate: 0 })).cls).toBe('best');
  });
});

describe('Miss, mates and forced moves', () => {
  it('flags a missed opportunity only when the chance was real', () => {
    const lines: [string, S][] = [['Ng5', { cp: 350 }], ['d3', { cp: 40 }]];
    expect(classifyMove(ctx(MID, 'd3', lines, { cp: 40 }, { prevOpponentEpl: 25, moverWinBeforeOpponentMove: 52 })).cls).toBe('miss');
    // the "chance" only reached 57%: not a real opportunity, ordinary band instead
    const small: [string, S][] = [['Ng5', { cp: 80 }], ['d3', { cp: -100 }]];
    expect(classifyMove(ctx(MID, 'd3', small, { cp: -100 }, { prevOpponentEpl: 12, moverWinBeforeOpponentMove: 45 })).cls).not.toBe('miss');
  });
  it('treats a missed forced mate as a Miss, a slower mate as Excellent or Good', () => {
    const fen = '5r1k/6pp/7N/3Q4/8/8/8/6K1 w - - 0 1';
    expect(classifyMove(ctx(fen, 'Qd3', [['Qg8+', { mate: 2 }], ['Nf7+', { cp: 300 }]], { cp: 250 })).cls).toBe('miss');
    expect(classifyMove(ctx(fen, 'Nf7+', [['Qg8+', { mate: 2 }], ['Nf7+', { mate: 4 }]], { mate: 4 })).cls).toBe('excellent');
    expect(classifyMove(ctx(fen, 'Nf7+', [['Qg8+', { mate: 2 }]], { mate: 6 })).cls).toBe('good');
  });
  it('treats the only legal move as forced Best and allowing mate as a Blunder', () => {
    const fen = '7k/8/8/8/8/8/6q1/7K w - - 0 1';
    expect(classifyMove(ctx(fen, 'Kxg2', [['Kxg2', { cp: 0 }]], { cp: 0 })).forced).toBe(true);
    expect(classifyMove(ctx(MID, 'Ng5', [['O-O', { cp: 30 }]], { mate: -2 })).cls).toBe('blunder');
  });
  it('changes with deeper analysis rather than locking in a shallow verdict', () => {
    const shallow = ctx(MID, 'Ng5', [['O-O', { cp: 30 }], ['Ng5', { cp: -200 }]], { cp: -200 });
    shallow.before.depth = 8; shallow.after.depth = 8;
    const deep = ctx(MID, 'Ng5', [['O-O', { cp: 30 }], ['Ng5', { cp: 10 }]], { cp: 10 });
    const a = classifyMove(shallow);
    const b = classifyMove(deep);
    expect(a.provisional).toBe(true);
    expect(['mistake', 'blunder']).toContain(a.cls);
    expect(b.provisional).toBe(false);
    expect(b.cls).toBe('excellent');
  });
});

describe('classification with the real engine', () => {
  let e: EngineController;
  beforeEach(() => { e = new EngineController(createNodeTransport); });
  afterEach(() => e.dispose());

  it('does not call 4.Bb5 in the Scandinavian Brilliant', async () => {
    const r = await reviewGame(e, 's', treeFromMoves(['e4', 'd5', 'exd5', 'Qxd5', 'Nc3', 'Qc6', 'Bb5']), { quickDepth: 8, deepDepth: 14 });
    const bb5 = r.moves[6];
    expect(bb5.san).toBe('Bb5');
    expect(bb5.cls).not.toBe('brilliant');
    expect(bb5.sacrifice).toBe(0);
    expect(['mistake', 'blunder']).toContain(r.moves[5].cls); // 3...Qc6 is the error
  });

  it('does not call the Légal-trap knight sacrifice Brilliant, but does mark the Greek gift', async () => {
    const legal = await reviewGame(e, 'l', treeFromMoves(['e4', 'e5', 'Nf3', 'd6', 'Bc4', 'Bg4', 'Nc3', 'g6', 'Nxe5']), { quickDepth: 8, deepDepth: 16 });
    expect(legal.moves[8].san).toBe('Nxe5');
    expect(legal.moves[8].cls).not.toBe('brilliant');
    let tree = createTree(GREEK);
    tree = addMove(tree, tree.rootId, 'Bxh7+', 'historical').tree;
    const greek = await reviewGame(e, 'g', tree, { quickDepth: 8, deepDepth: 16 });
    expect(greek.moves[0].cls).toBe('brilliant');
  });

  it('verifies acceptance with the engine instead of a static capture choice', async () => {
    const fen = 'rn1qkbnr/ppp2p1p/3p2p1/4p3/2B1P1b1/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 0 5';
    const r = await verifySacrifice(e, fen, 'f3e5', ['g4d1', 'd6e5'], 'w', 14, 1);
    // dxe5 is answered by Qxg4 (material back), so only Bxd1 counts as accepting: and it loses
    expect(r?.real).toBe(true);
    expect(r?.acceptUci).toBe('Bxd1');
    expect(r!.acceptWin).toBeGreaterThan(95);
  });
});
