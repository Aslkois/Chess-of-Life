import { Chess } from 'chess.js';
import { classifyMove, type MoveContext, type SacrificeCheck } from '../src/analysis/classify';
import { EngineController } from '../src/engine/controller';
import { verifySacrifice } from '../src/analysis/verify';
import { explainMove } from '../src/analysis/explainMove';
import { createNodeTransport } from './nodeTransport';
import { after, res, uci } from './helpers';

/** The game from the screenshot (Scandinavian, Mieses-Kotrč), up to White's 17th move. */
const GAME = 'e4 d5 exd5 Qxd5 Nc3 Qe5+ Be2 Nc6 Nf3 Qa5 d4 e6 O-O Bd7 Bd2 O-O-O Nb5 Qb6 c4 Nb4 a4 Nf6 c5 Bxc5 dxc5 Qxc5 Rc1 Qe7 Rxc7+ Kb8 Bf4 Nfd5'.split(' ');
/** The FEN as reconstructed in the report was '... w - - 0 17'; the real game has halfmove clock 3. Same position. */
const RC8 = '1k1r3r/ppRbqppp/4p3/1N1n4/Pn3B2/5N2/1P2BPPP/3Q1RK1 w - - 3 17';

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
const chk = (acceptWin: number, real = true): SacrificeCheck => ({ acceptUci: 'x', acceptWin, depth: 16, real });

describe('17. Rc8+!! (the reported misclassification)', () => {
  it('the reconstructed FEN is the real game position, and the tactic is legal', () => {
    const c = new Chess();
    for (const m of GAME) c.move(m);
    expect(c.fen()).toBe(RC8);
    expect(c.fen().split(' ').slice(0, 4)).toEqual('1k1r3r/ppRbqppp/4p3/1N1n4/Pn3B2/5N2/1P2BPPP/3Q1RK1 w - - 0 17'.split(' ').slice(0, 4));
    c.move('Rc8+');
    expect(c.moves()).toEqual(['Kxc8']); // double check: the king must take
    c.move('Kxc8');
    c.move('Nxa7#');
    expect(c.isCheckmate()).toBe(true);
  });

  it('is classified Brilliant by the general rules, with real Stockfish, and explained as one', async () => {
    const e = new EngineController(createNodeTransport);
    try {
      const before = await e.analyze({ fen: RC8, depth: 16, multipv: 3 });
      const fa = after(RC8, 'Rc8+');
      const aft = await e.analyze({ fen: fa, depth: 16, multipv: 1 });
      // the alternatives are winning but not mating: this is what used to block Brilliant
      const alt = before.lines.find((l) => l.pv[0] !== 'c7c8')!;
      expect(alt.score.mate).toBeUndefined();
      expect(alt.score.cp!).toBeGreaterThan(500);
      const base: MoveContext = { fenBefore: RC8, uci: 'c7c8', color: 'w', before, after: aft, legalMoves: new Chess(RC8).moves().length, targetDepth: 16 };
      const first = classifyMove(base);
      expect(first.needsSacrificeCheck).toBe(true); // goes on to verification instead of stopping at "already winning"
      const check = await verifySacrifice(e, RC8, 'c7c8', first.acceptances, 'w', 16, 0);
      expect(check).toMatchObject({ acceptUci: 'Kxc8', real: true });
      const c = classifyMove({ ...base, sacrificeCheck: check });
      expect(c.cls).toBe('brilliant');
      expect(c.notes.join(' ')).toMatch(/only legal reply/);
      expect(c.notes.join(' ')).toMatch(/into a forced mate/);
      // the explanation agrees with the rating and uses the same analysis
      const x = explainMove({ fenBefore: RC8, uci: 'c7c8', cls: c.cls, epl: c.epl, before: before.lines, after: aft.lines });
      expect(x.kind).toBe('sacrifice');
      expect(x.points[0].text).toMatch(/^Brilliant: Rc8\+ sacrifices the rook on c8/);
      expect(x.points[0].text).toMatch(/double check/);
      expect(x.points[0].text).toMatch(/Kxc8 is Black's only legal reply/);
      expect(x.points[0].text).toMatch(/Nxa7#/);
      expect(x.points[0].text).toMatch(/mate in 2 counting Rc8\+/);
      expect(x.points.map((p) => p.text).join(' ')).not.toMatch(/deals with the threat/);
    } finally { e.dispose(); }
  }, 120000);
});

describe('Brilliant rules (deterministic analysis snapshots)', () => {
  // rook on c7 offered (Rc8+ position); scores chosen to exercise each rule
  const mating = (altScore: S) => ctx(RC8, 'Rc8+', [['Rc8+', { mate: 2 }], ['Qxd5', altScore], ['Rxd7', { cp: 550 }]], { mate: 1 }, { sacrificeCheck: chk(100) });
  it('a sacrifice that forces mate from a merely winning position is Brilliant', () => {
    expect(classifyMove(mating({ cp: 1042 })).cls).toBe('brilliant');
  });
  it('not when the alternative already forces mate', () => {
    const c = classifyMove(mating({ mate: 3 }));
    expect(c.cls).not.toBe('brilliant');
    expect(c.notes.join(' ')).toMatch(/forced mate was available without it/);
  });
  it('not a sacrifice from a decisively won position that does not force mate', () => {
    const c = classifyMove(ctx(RC8, 'Rc8+', [['Rc8+', { cp: 1500 }], ['Qxd5', { cp: 1400 }]], { cp: 1500 }, { sacrificeCheck: chk(99) }));
    expect(c.cls).not.toBe('brilliant');
    expect(c.notes.join(' ')).toMatch(/already completely winning/);
  });
  it('an exchange sacrifice in a balanced position is Brilliant when acceptance is sound', () => {
    // Rxd5: the rook takes a knight defended by a pawn (net -2, an exchange)
    const fen = '4k3/8/4p3/3n4/8/8/5PPP/3RK3 w - - 0 1';
    const c = classifyMove(ctx(fen, 'Rxd5', [['Rxd5', { cp: 40 }], ['g3', { cp: 10 }]], { cp: 40 }, { sacrificeCheck: chk(55) }));
    expect(c.sacrifice).toBe(2);
    expect(c.cls).toBe('brilliant');
  });
  it('a bad sacrifice is not Brilliant', () => {
    const c = classifyMove(ctx(RC8, 'Rc8+', [['Qxd5', { cp: 1042 }], ['Rc8+', { cp: 100 }]], { cp: 100 }, { sacrificeCheck: chk(20) }));
    expect(c.cls).not.toBe('brilliant');
    expect(['inaccuracy', 'mistake', 'blunder']).toContain(c.cls);
  });
  it('a sacrifice that is not checked yet waits for verification (never Brilliant on a guess)', () => {
    const c = classifyMove(mating({ cp: 1042 }));
    const unverified = classifyMove({ ...mating({ cp: 1042 }), sacrificeCheck: undefined });
    expect(c.cls).toBe('brilliant');
    expect(unverified.cls).toBe('best');
    expect(unverified.needsSacrificeCheck).toBe(true);
  });
  it('a best move that is not a sacrifice is Best, not Brilliant, even with a mate score', () => {
    const fen = '6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1';
    const c = classifyMove(ctx(fen, 'Ra8#', [['Ra8#', { mate: 1 }], ['h3', { cp: 300 }]], { mate: 0 }));
    expect(c.cls).not.toBe('brilliant');
  });
  it('mate scores and large evaluations are kept apart', () => {
    // playing +10 instead of a mate in 2 is not "Best", though both read as ~100%
    const c = classifyMove(ctx(RC8, 'Qxd5', [['Rc8+', { mate: 2 }], ['Qxd5', { cp: 1042 }]], { cp: 1042 }));
    expect(c.cls).not.toBe('best');
    expect(c.epl).toBeGreaterThan(0);
  });
  it('several nearly equal moves are all Best/Excellent, none Great', () => {
    const fen = new Chess().fen();
    for (const m of ['e4', 'd4', 'Nf3']) {
      const c = classifyMove(ctx(fen, m, [['e4', { cp: 30 }], ['d4', { cp: 28 }], ['Nf3', { cp: 27 }]], { cp: m === 'e4' ? 30 : m === 'd4' ? 28 : 27 }));
      expect(['best', 'excellent']).toContain(c.cls);
    }
  });
});
