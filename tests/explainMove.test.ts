import { Chess } from 'chess.js';
import { EngineController } from '../src/engine/controller';
import { createNodeTransport } from './nodeTransport';
import { exchangeLine, explainMove, isForcing, type Explanation, type ExplainInput } from '../src/analysis/explainMove';
import { classifyMove, type Classification } from '../src/analysis/classify';

let e: EngineController;
beforeAll(() => { e = new EngineController(createNodeTransport); });
afterAll(() => e.dispose());

/** Analyse a real position with Stockfish, classify the move, then explain it. */
async function explain(fen: string, san: string, prev?: ExplainInput['prev']): Promise<{ x: Explanation; cls: Classification; input: ExplainInput }> {
  const c = new Chess(fen);
  const m = c.move(san);
  const uci = m.from + m.to + (m.promotion ?? '');
  const before = await e.analyze({ fen, depth: 14, multipv: 3 });
  const after = await e.analyze({ fen: c.fen(), depth: 14, multipv: 1 });
  const cls = classifyMove({ fenBefore: fen, uci, color: m.color, before, after, legalMoves: new Chess(fen).moves().length, targetDepth: 14, prevOpponentEpl: prev?.epl, moverWinBeforeOpponentMove: prev ? 50 : undefined });
  const input: ExplainInput = { fenBefore: fen, uci, cls: cls.cls, epl: cls.epl, before: before.lines, after: after.lines, prev: prev ?? null };
  return { x: explainMove(structuredClone(input)), cls: cls.cls, input };
}
const text = (x: Explanation) => x.points.map((p) => p.text).join(' \n');
const arrows = (x: Explanation) => x.points.flatMap((p) => p.marks.arrows.map((a) => `${a.from}${a.to}:${a.tone}`));

/** Every line is legal and starts from the position before the move. */
function checkLines(x: Explanation) {
  for (const l of x.lines) {
    expect(l.startFen).toBe(x.fenBefore);
    const c = new Chess(l.startFen);
    for (const st of l.steps) {
      const m = c.move({ from: st.uci.slice(0, 2), to: st.uci.slice(2, 4), promotion: st.uci[4] });
      expect(m.san).toBe(st.san);
      expect(c.fen()).toBe(st.fen);
    }
  }
}

describe('Game Review explanations on real positions (Stockfish)', () => {
  it('development: the bishop’s diagonal and its target, plus a plan that is not forced', async () => {
    const { x } = await explain('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', 'Bc4');
    expect(x.kind).toBe('development');
    expect(text(x)).toMatch(/a2–g8 diagonal/);
    expect(text(x)).toMatch(/pawn on f7 \(defended only by the king\)/);
    expect(arrows(x)).toContain('c4f7:concept');
    const plan = x.points.find((p) => /possible plan, not a forced line/.test(p.text));
    expect(plan).toBeTruthy();
    expect(plan!.marks.arrows.every((a) => a.dashed && a.tone === 'plan')).toBe(true);
    expect(text(x)).not.toMatch(/develops a piece\./);
    checkLines(x);
  }, 60000);

  it('inaccuracy: the ignored threat, the better move as an arrow, and lines to compare', async () => {
    const { x, cls } = await explain('r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4', 'a3');
    expect(['inaccuracy', 'mistake']).toContain(cls);
    expect(x.points[0].text).toMatch(/pawn on e4 was already attacked by the knight on f6.*Nxe4/);
    expect(x.points[0].marks.arrows).toContainEqual({ from: 'f6', to: 'e4', tone: 'threat' });
    const better = x.points.find((p) => p.text.startsWith('Better was'))!;
    expect(better.fen).toBe(x.fenBefore);
    expect(better.marks.arrows.map((a) => a.tone)).toEqual(['played', 'better']);
    expect(better.marks.icons.map((i) => i.cls)).toEqual([cls, 'best']);
    expect(x.lines.map((l) => l.id)).toEqual(expect.arrayContaining(['played', 'best']));
    expect(x.compare && x.compare.aLine === 'played' && x.compare.bLine === 'best').toBe(true);
    expect(x.compare!.b.win).toBeGreaterThan(x.compare!.a.win);
    checkLines(x);
  }, 60000);

  it('best vs second best: no invented difference when they are equal', async () => {
    const { x } = await explain(new Chess().fen(), 'e4');
    expect(x.compare?.approxEqual).toBe(true);
    expect(text(x)).toMatch(/about as good: the engine sees no meaningful difference/);
    expect(x.lines.some((l) => l.id === 'second')).toBe(true);
  }, 60000);

  it('a bad trade: the exchange sequence and the material it costs', async () => {
    const { x } = await explain('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3', 'Nxe5');
    expect(['mistake', 'blunder']).toContain(x.kind);
    expect(x.points[0].text).toMatch(/^A bad trade: Nxe5 wins a pawn, but the knight on e5 is attacked by the knight on c6.*2 pawns down/);
    const ex = x.lines.find((l) => l.id === 'exchange')!;
    expect(ex.steps.map((s) => s.san)).toEqual(['Nxe5', 'Nxe5']);
    expect(ex.summary).toMatch(/loses 2 pawns/);
    checkLines(x);
  }, 60000);

  it('a fork: attacking relationships as arrows, and a forcing line rather than a plan', async () => {
    const { x } = await explain('2q3k1/8/8/3N4/8/8/8/4K3 w - - 0 1', 'Ne7+');
    expect(x.kind).toBe('tactic');
    expect(text(x)).toMatch(/Fork: the knight on e7 attacks the king on g8 and the queen on c8/);
    expect(arrows(x)).toEqual(expect.arrayContaining(['e7g8:better', 'e7c8:better']));
    expect(x.lines.find((l) => l.id === 'played')!.forced).toBe(true);
    expect(text(x)).not.toMatch(/possible plan/);
  }, 60000);

  it('blocking a check: the checking line and why the block holds', async () => {
    const { x } = await explain('rnbqk1nr/pppp1ppp/8/4P3/1b6/8/PPP1PPPP/RNBQKBNR w KQkq - 1 3', 'c3');
    expect(x.kind).toBe('defence');
    expect(x.points[0].text).toMatch(/in check from the bishop on b4: it blocks the check by putting the pawn on c3/);
    expect(x.points[0].marks.arrows).toContainEqual({ from: 'b4', to: 'e1', tone: 'threat' });
    expect(text(x)).toMatch(/attacks the bishop on b4/);
  }, 60000);

  it('a blunder: the loose queen, who wins it, and the better move (for Black too)', async () => {
    const { x } = await explain('rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2', 'Qh4');
    expect(x.kind).toBe('blunder');
    expect(x.mover).toBe('b');
    expect(x.points[0].text).toMatch(/queen on h4 is attacked by the knight on f3 and not defended at all: Nxh4 wins it/);
    expect(x.points[0].marks.arrows).toContainEqual({ from: 'f3', to: 'h4', tone: 'threat' });
    expect(text(x)).toMatch(/White comes out a queen's worth/);
    expect(text(x)).toMatch(/Better was \S+ .*winning chances for Black/);
    checkLines(x);
  }, 60000);

  it('free material: why it can be taken safely', async () => {
    const { x } = await explain('rnb1kbnr/pppp1ppp/8/4p1q1/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 0 1', 'Bxg5');
    expect(x.kind).toBe('free-material');
    expect(x.points[0].text).toMatch(/queen on g5 was not defended\. Nothing of Black's can take back on g5/);
  }, 60000);

  it('a missed opportunity after the opponent’s mistake', async () => {
    const { x } = await explain('rnb1kbnr/pppp1ppp/8/4p1q1/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 0 1', 'a3', { san: 'Qg5', uci: 'd8g5', cls: 'blunder', epl: 60 });
    expect(x.kind).toBe('miss');
    expect(x.points[0].text).toMatch(/Black's previous move Qg5 was a blunder, and Bxg5 would have taken advantage of it/);
    expect(x.points[0].marks.arrows).toContainEqual({ from: 'c1', to: 'g5', tone: 'better' });
    expect(x.lines.find((l) => l.id === 'best')!.summary).toMatch(/White wins/);
  }, 60000);

  it('a sound sacrifice is recognised as justified, without claiming what the line does not show', async () => {
    const { x } = await explain('r1bq1rk1/pppnnppp/4p3/3pP3/1b1P4/2NB1N2/PPP2PPP/R1BQK2R w KQ - 0 8', 'Bxh7+');
    expect(x.kind).toBe('sacrifice');
    expect(x.points[0].text).toMatch(/offers the bishop on h7 \(Kxh7 would take it\), and it is justified|Brilliant: Bxh7\+ sacrifices the bishop on h7/);
    expect(x.lines.find((l) => l.id === 'exchange')!.label).toBe('If Black takes on h7');
  }, 60000);
});

describe('explanation helpers', () => {
  it('builds the exchange on a square by least valuable attacker, stopping when it no longer pays', () => {
    // Rxd5: the rook takes a pawn defended by a pawn; Black recaptures once
    expect(exchangeLine('4k3/8/2p5/3p4/8/8/8/3RK3 w - - 0 1', 'd1d5', [])).toEqual(['d1d5', 'c6d5']);
    // the engine's own recapture sequence is used when it plays on that square
    expect(exchangeLine('4k3/8/2p5/3p4/8/8/8/3RK3 w - - 0 1', 'd1d5', ['c6d5', 'e1e2'])).toEqual(['d1d5', 'c6d5']);
  });
  it('tells forcing lines from possible plans', () => {
    const start = new Chess().fen();
    expect(isForcing(start, ['e2e4', 'e7e5', 'g1f3', 'b8c6'])).toBe(false);
    expect(isForcing('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', ['a1a8'])).toBe(true);
  });
});
