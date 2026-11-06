import 'fake-indexeddb/auto';
import { Chess } from 'chess.js';
import { ALL_ASSISTS, allowed } from '../src/modes';
import { agreeDraw, applyResult, checkFlag, claimDraw, createMatch, emptyRankedProfile, playRankedMove, resignRanked, rivalAcceptsDraw, rivalLevelFor } from '../src/rival/ranked';
import { expectedScore, INITIAL_RATING, updateRating } from '../src/rival/glicko';
import { emptyRivalModel, updateRivalModel, weaknesses } from '../src/rival/model';
import { applyStrategy, deriveStrategy, NEUTRAL_STRATEGY } from '../src/rival/policy';
import { candidatesFrom, levelRating, pickMove, strengthFor } from '../src/engine/strength';
import { EngineController } from '../src/engine/controller';
import { mulberry32 } from '../src/util/rng';
import { deleteAllData, get, put } from '../src/db/db';
import { learnFromRankedGame, loadRivalModel, recordRankedResult } from '../src/services/ranked';
import { reviewGame } from '../src/analysis/review';
import { treeFromMoves } from '../src/chess/tree';
import { createNodeTransport } from './nodeTransport';
import { createMockTransport } from './mockEngine';
import type { GameReview, MoveReview } from '../src/analysis/review';
import { res } from './helpers';

const TC = { initial: 300, increment: 2 };

describe('Ranked assistance restrictions', () => {
  it('allows no assistance during an active ranked game', () => {
    for (const a of ALL_ASSISTS) expect(allowed('ranked-active', a)).toBe(false);
    expect(allowed('ranked-finished', 'evalBar')).toBe(true);
    expect(allowed('ranked-finished', 'branches')).toBe(true);
    expect(allowed('coach', 'hints')).toBe(true);
    expect(allowed('coach', 'engineLines')).toBe(false);
    expect(allowed('coach', 'bestMoveArrows')).toBe(false);
  });
});

describe('Ranked match rules', () => {
  it('enforces the clock with increments and records time per move', () => {
    let s = createMatch({ playerColor: 'w', rivalLevel: 5, timeControl: TC, now: 0, seed: 1 });
    s = playRankedMove(s, 'e2e4', 10_000);
    expect(s.match.timeSpent[0]).toBe(10_000);
    expect(s.match.clockAfter[0]).toBe(292_000);
    s = playRankedMove(s, 'e7e5', 13_000);
    expect(s.clock.remaining.b).toBe(299_000);
    // white thinks too long and flags
    const flagged = checkFlag(s, 13_000 + 292_001);
    expect(flagged.match.status).toBe('finished');
    expect(flagged.match.reason).toBe('timeout');
    expect(flagged.match.result).toBe('0-1');
    expect(() => playRankedMove(flagged, 'g1f3', 999_999)).toThrow();
  });

  it('handles checkmate, resignation, draw claims and agreements', () => {
    let s = createMatch({ playerColor: 'b', rivalLevel: 5, timeControl: { initial: 0, increment: 0 }, now: 0 });
    for (const m of ['f2f3', 'e7e5', 'g2g4', 'd8h4']) s = playRankedMove(s, m, 1);
    expect(s.match.result).toBe('0-1');
    expect(s.match.reason).toBe('checkmate');
    let t = createMatch({ playerColor: 'w', rivalLevel: 5, timeControl: { initial: 0, increment: 0 }, now: 0 });
    expect(resignRanked(t, 1).match.result).toBe('0-1');
    for (const m of ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']) t = playRankedMove(t, m, 1);
    expect(claimDraw(t, 'threefold-repetition', 2).match.reason).toBe('threefold-repetition');
    expect(() => claimDraw(t, 'fifty-move', 2)).toThrow();
    expect(agreeDraw(t, 2).match.result).toBe('1/2-1/2');
  });

  it('accepts draws only by its fixed rule', () => {
    expect(rivalAcceptsDraw(30, 10)).toBe(false);
    expect(rivalAcceptsDraw(45, 50)).toBe(true);
    expect(rivalAcceptsDraw(70, 50)).toBe(false);
  });
});

describe('Ranked rating (Glicko-2)', () => {
  it('moves ratings in the right direction with uncertainty', () => {
    const win = updateRating(INITIAL_RATING, { r: 1200, rd: 60 }, 1);
    const loss = updateRating(INITIAL_RATING, { r: 1200, rd: 60 }, 0);
    expect(win.r).toBeGreaterThan(1200);
    expect(loss.r).toBeLessThan(1200);
    expect(win.rd).toBeLessThan(350);
    expect(expectedScore({ r: 1500, rd: 50, vol: 0.06 }, { r: 1500, rd: 50 })).toBeCloseTo(0.5, 5);
    // Glickman's worked example
    const ex = { r: 1500, rd: 200, vol: 0.06 };
    const one = updateRating(ex, { r: 1400, rd: 30 }, 1);
    expect(one.r).toBeGreaterThan(1500);
  });

  it('applies match results once and picks a matching Rival level', () => {
    const p = emptyRankedProfile();
    expect(levelRating(rivalLevelFor(p))).toBe(1200);
    let s = createMatch({ playerColor: 'w', rivalLevel: 6, timeControl: TC, now: 0 });
    s = resignRanked(s, 5);
    const r1 = applyResult(p, s.match, 10);
    expect(r1.profile.losses).toBe(1);
    expect(r1.profile.rating.r).toBeLessThan(1200);
    const r2 = applyResult(r1.profile, r1.match, 20);
    expect(r2.profile.losses).toBe(1); // not applied twice
  });
});

function fakeReview(moves: Partial<MoveReview>[]): GameReview {
  return {
    gameId: 'x', version: 1, createdAt: 0, updatedAt: 0, quickDepth: 8, deepDepth: 12, status: 'complete', progress: { done: 1, total: 1, pass: 'deep' },
    positions: [], moves: moves as MoveReview[], accuracy: { w: null, b: null }, counts: { w: {} as never, b: {} as never }, opening: null, bookPlies: 0, turningPoints: [], summary: [],
  };
}

describe('Rival adaptation', () => {
  beforeEach(async () => { await deleteAllData(); });

  it('learns only from ranked games and never from Coach data', async () => {
    // Coach history in the database must not affect the Rival model
    await put('coachAttempts', { id: 'a1', sessionId: 's1', ply: 0, fen: new Chess().fen(), attemptNo: 2, uci: 'e2e4', san: 'e4', cls: 'best', epl: 0, provisional: false, hintsBefore: 3, tookBack: false, final: true, independent: false, ts: 0 });
    await put('profiles', { ...(await import('../src/coach/profile')).emptyProfile() });
    const before = await loadRivalModel();
    expect(before.games).toBe(0);

    const moves = ['e4', 'e5', 'Qh5', 'Nc6', 'Bc4', 'Nf6', 'Qxf7#'];
    let s = createMatch({ playerColor: 'b', rivalLevel: 5, timeControl: { initial: 0, increment: 0 }, now: 0 });
    const c = new Chess();
    for (const san of moves) { const m = c.move(san); s = playRankedMove(s, m.from + m.to, 1); }
    expect(s.match.result).toBe('1-0');
    const { match } = await recordRankedResult(s.match);
    expect(match.ratingAfter!.r).toBeLessThan(1200);
    const e = new EngineController(createNodeTransport);
    const review = await reviewGame(e, 'g', treeFromMoves(moves), { quickDepth: 6, deepDepth: 8 });
    e.dispose();
    const adaptation = await learnFromRankedGame(match, review);
    const model = await loadRivalModel();
    expect(model.games).toBe(1);
    // only the player's (Black's) committed moves count: 3 moves
    const totalDecisions = model.aggression.total;
    expect(totalDecisions).toBe(3);
    expect(adaptation.changes.length).toBeGreaterThan(0);
    expect(await get('rivalAdaptations', adaptation.id)).toBeTruthy();
    expect((await get('rankedMatches', match.id))?.analysisDone).toBe(true);
  });

  it('turns repeated weaknesses into a stable strategy', () => {
    let m = emptyRivalModel();
    const fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3';
    for (let g = 0; g < 4; g++) {
      const mv: Partial<MoveReview>[] = [];
      for (let i = 0; i < 12; i++) mv.push({ color: 'w', uci: 'f1c4', bestUci: 'f1b5', epl: 25, ply: 41, winBefore: 50, phase: 'endgame', sacrifice: 0 });
      const upd = updateRivalModel(m, { matchId: `m${g}`, playerColor: 'w', score: 0, opening: { key: 'C44 Kings Pawn', name: "King's Pawn Game", line: ['e2e4', 'e7e5'] }, review: fakeReview(mv), fens: new Array(13).fill(fen), timeSpent: [], clockAfter: [], initialMs: 0 });
      m = upd.model;
    }
    const w = weaknesses(m);
    expect(w.length).toBeGreaterThan(0);
    const strat = deriveStrategy(m, 'b');
    expect(strat.openingLines[0].name).toBe("King's Pawn Game");
    expect(strat.notes.length).toBeGreaterThan(0);
    expect(deriveStrategy(m, 'b')).toEqual(strat); // deterministic
  });

  it('strategy only reorders moves inside the quality tolerance', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';
    const a = res(fen, [['Nc6', { cp: -30 }], ['d6', { cp: -15 }], ['Qh4', { cp: 250 }]]);
    const prof = strengthFor(12);
    const cands = candidatesFrom(fen, a, prof.tolerance);
    expect(cands.map((c) => c.san)).not.toContain('Qh4');
    const shaped = applyStrategy(cands, { ...NEUTRAL_STRATEGY, kingAttack: 1.5 }, { fen, history: ['e2e4', 'e7e5', 'g1f3'], rivalColor: 'b' });
    expect(shaped.map((c) => c.san).sort()).toEqual(cands.map((c) => c.san).sort());
  });

  it('plays only legal moves at a fixed strength', async () => {
    const e = new EngineController(createNodeTransport);
    const rand = mulberry32(42);
    const prof = strengthFor(3);
    let fen = new Chess().fen();
    const c = new Chess();
    for (let i = 0; i < 8; i++) {
      const { move } = await pickMove(e, fen, prof, rand);
      expect(c.moves({ verbose: true }).some((m) => m.from + m.to + (m.promotion ?? '') === move.uci)).toBe(true);
      expect(move.epl).toBeLessThanOrEqual(prof.tolerance);
      c.move({ from: move.uci.slice(0, 2), to: move.uci.slice(2, 4), promotion: move.uci[4] });
      fen = c.fen();
    }
    e.dispose();
    expect(strengthFor(3)).toEqual(prof); // levels are fixed
    expect(strengthFor(20).tolerance).toBeLessThan(strengthFor(1).tolerance);
  });

  it('falls back to a legal move if the engine gives nothing usable', async () => {
    const e = new EngineController(() => createMockTransport());
    // mock engine always suggests e7e5/e2e4 which may be illegal here
    const fen = '4k3/8/8/8/8/8/8/R3K3 w Q - 0 1';
    const { move } = await pickMove(e, fen, strengthFor(5), mulberry32(1));
    expect(new Chess(fen).moves({ verbose: true }).some((m) => m.from + m.to === move.uci)).toBe(true);
    e.dispose();
  });
});
