import { Chess } from 'chess.js';
import { classifyMove, gameAccuracy, moveAccuracy, type MoveContext } from '../src/analysis/classify';
import { EngineController } from '../src/engine/controller';
import { reviewGame } from '../src/analysis/review';
import { treeFromMoves } from '../src/chess/tree';
import { identifyOpening, isBookMove } from '../src/analysis/openings';
import { createNodeTransport } from './nodeTransport';
import { after, res, uci } from './helpers';

const MID = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';

function ctx(fen: string, played: string, beforeLines: [string, { cp?: number; mate?: number }][], afterScore: { cp?: number; mate?: number }, extra: Partial<MoveContext> = {}): MoveContext {
  const fa = after(fen, played);
  const c = new Chess(fen);
  return {
    fenBefore: fen, uci: uci(fen, played), color: c.turn(), before: res(fen, beforeLines), after: res(fa, [[new Chess(fa).moves()[0], afterScore]]),
    legalMoves: c.moves().length, targetDepth: 16, ...extra,
  };
}

describe('move classification', () => {
  it('classifies the engine move as Best', () => {
    const r = classifyMove(ctx(MID, 'Ng5', [['Ng5', { cp: 40 }], ['d3', { cp: 30 }]], { cp: 40 }));
    expect(r.cls).toBe('best');
    expect(r.epl).toBe(0);
    expect(r.accuracy).toBe(100);
  });

  it('uses expected-points bands for Excellent / Good / Inaccuracy / Mistake / Blunder', () => {
    const lines: [string, { cp: number }][] = [['Ng5', { cp: 40 }], ['d3', { cp: 30 }]];
    expect(classifyMove(ctx(MID, 'd3', lines, { cp: 30 })).cls).toBe('excellent');
    expect(classifyMove(ctx(MID, 'O-O', lines, { cp: 0 })).cls).toBe('good');
    expect(classifyMove(ctx(MID, 'Nc3', lines, { cp: -60 })).cls).toBe('inaccuracy');
    expect(classifyMove(ctx(MID, 'a3', lines, { cp: -150 })).cls).toBe('mistake');
    const b = classifyMove(ctx(MID, 'Bxf7+', lines, { cp: -400 }));
    expect(b.cls).toBe('blunder');
    expect(b.epl).toBeGreaterThan(20);
    expect(b.accuracy).toBeLessThan(40);
  });

  it('marks results provisional below the target depth', () => {
    const c = ctx(MID, 'Ng5', [['Ng5', { cp: 40 }]], { cp: 40 });
    c.before.depth = 8; c.after.depth = 8;
    expect(classifyMove(c).provisional).toBe(true);
  });

  it('treats the only legal move as forced', () => {
    const fen = '7k/8/8/8/8/8/6q1/7K w - - 0 1';
    const c = new Chess(fen);
    expect(c.moves()).toEqual(['Kxg2']);
    const r = classifyMove(ctx(fen, 'Kxg2', [['Kxg2', { cp: 0 }]], { cp: 0 }));
    expect(r.forced).toBe(true);
    expect(r.cls).toBe('best');
  });

  it('grants Book only with the opening reference', () => {
    const start = new Chess().fen();
    expect(isBookMove(start, 'e2e4')).toBe(true);
    expect(isBookMove(start, 'e2e3')).toBe(true); // Van 't Kruijs Opening is catalogued
    expect(isBookMove(after(start, 'a4'), 'h7h5')).toBe(false);
    const r = classifyMove(ctx(start, 'e4', [['e4', { cp: 30 }], ['d4', { cp: 30 }]], { cp: 30 }, { isBook: true }));
    expect(r.cls).toBe('book');
    const notBook = classifyMove(ctx(start, 'e4', [['e4', { cp: 30 }]], { cp: 30 }, { isBook: false }));
    expect(notBook.cls).toBe('best');
    const id = identifyOpening(
      [start, after(start, 'e4'), after(after(start, 'e4'), 'c5')],
      ['e2e4', 'c7c5'],
    );
    expect(id.opening?.name).toMatch(/Sicilian/);
    expect(id.bookPlies).toBe(2);
  });

  it('detects a Miss only after an opponent error that was not exploited', () => {
    const lines: [string, { cp: number }][] = [['Ng5', { cp: 350 }], ['d3', { cp: 40 }]];
    const miss = classifyMove(ctx(MID, 'd3', lines, { cp: 40 }, { prevOpponentEpl: 25, moverWinBeforeOpponentMove: 52 }));
    expect(miss.cls).toBe('miss');
    // same move without an opponent error is just a mistake/blunder
    const plain = classifyMove(ctx(MID, 'd3', lines, { cp: 40 }));
    expect(['mistake', 'blunder']).toContain(plain.cls);
    // failing to exploit AND making things worse than before is not a "miss"
    const worse = classifyMove(ctx(MID, 'a3', lines, { cp: -300 }, { prevOpponentEpl: 25, moverWinBeforeOpponentMove: 52 }));
    expect(worse.cls).toBe('blunder');
  });

  it('calls a missed short forced mate a Miss', () => {
    const fen = '5r1k/6pp/7N/3Q4/8/8/8/6K1 w - - 0 1';
    const r = classifyMove(ctx(fen, 'Qd3', [['Qg8+', { mate: 2 }], ['Nf7+', { cp: 300 }]], { cp: 250 }));
    expect(r.cls).toBe('miss');
    expect(r.notes.join(' ')).toMatch(/mate in 2/);
  });

  it('awards Great for the only good move, but not for recaptures', () => {
    const lines: [string, { cp: number }][] = [['Ng5', { cp: 60 }], ['d3', { cp: -250 }]];
    expect(classifyMove(ctx(MID, 'Ng5', lines, { cp: 60 })).cls).toBe('great');
    // a recapture on the square the opponent just captured on is never Great
    const fen = 'rnbqkbnr/ppp1pppp/8/3P4/8/8/PPPP1PPP/RNBQKBNR b KQkq - 0 2';
    const rl: [string, { cp: number }][] = [['Qxd5', { cp: 0 }], ['Nf6', { cp: -250 }]];
    expect(classifyMove(ctx(fen, 'Qxd5', rl, { cp: 0 }, { prevUci: 'e4d5' })).cls).toBe('best');
  });

  it('awards Brilliant only for a verified, sound sacrifice', () => {
    const fen = '5r1k/6pp/7N/3Q4/8/8/8/6K1 w - - 0 1';
    const base = ctx(fen, 'Qg8+', [['Qg8+', { mate: 2 }], ['Nf7+', { cp: 300 }]], { mate: 1 });
    const unverified = classifyMove(base);
    expect(unverified.sacrifice).toBeGreaterThanOrEqual(2);
    expect(unverified.needsSacrificeCheck).toBe(true);
    expect(unverified.cls).not.toBe('brilliant');
    expect(classifyMove({ ...base, sacrificeCheck: { acceptUci: 'Rxg8', acceptWin: 100, depth: 16, real: true } }).cls).toBe('brilliant');
    expect(classifyMove({ ...base, sacrificeCheck: { acceptUci: 'Rxg8', acceptWin: 10, depth: 16, real: true } }).cls).not.toBe('brilliant');
    // simply hanging a piece is not a sacrifice-brilliancy
    const hang = classifyMove(ctx(MID, 'Bxf7+', [['Ng5', { cp: 40 }]], { cp: -300 }, { sacrificeCheck: { acceptUci: 'Kxf7', acceptWin: 0, depth: 16, real: true } }));
    expect(hang.cls).toBe('blunder');
  });

  it('computes accuracy from expected points', () => {
    expect(moveAccuracy(0)).toBe(100);
    expect(moveAccuracy(10)).toBeLessThan(70);
    expect(gameAccuracy([100, 100, 100], [50, 50, 50, 50], [true, false, true])).toBeCloseTo(100, 0);
    expect(gameAccuracy([100, 20], [50, 50, 10], [true, true])!).toBeLessThan(70);
  });
});

describe('full review with the real engine', () => {
  it('reviews a game, classifying both sides, and refines provisional results', async () => {
    const e = new EngineController(createNodeTransport);
    const moves = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];
    const tree = treeFromMoves(moves);
    const updates: string[] = [];
    const review = await reviewGame(e, 'g1', tree, { quickDepth: 6, deepDepth: 10, onUpdate: (r) => updates.push(r.status) });
    e.dispose();
    expect(review.status).toBe('complete');
    expect(updates).toContain('quick');
    expect(review.moves).toHaveLength(7);
    expect(review.moves.every((m) => !m.provisional)).toBe(true);
    expect(review.moves[0].cls).toBe('book');
    const nf6 = review.moves[5];
    expect(nf6.san).toBe('Nf6');
    expect(nf6.cls).toBe('blunder');
    expect(nf6.bestSan).not.toBe('Nf6');
    expect(nf6.explanation.join(' ')).toMatch(/Qxf7#/);
    expect(review.moves[6].cls === 'best' || review.moves[6].cls === 'great').toBe(true);
    expect(review.accuracy.w!).toBeGreaterThan(review.accuracy.b!);
    expect(review.positions[7].score).toEqual({ mated: 'b' });
    expect(review.opening).not.toBeNull();
    expect(review.turningPoints).toContain(5);
    expect(review.summary.join(' ')).toMatch(/Costliest decision: 3\.\.\. Nf6/);
  });
});
