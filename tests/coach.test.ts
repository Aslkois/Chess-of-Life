import 'fake-indexeddb/auto';
import { Chess } from 'chess.js';
import { commitCoachMove, commitPending, isPlayerTurn, proposeMove, restoreCoachState, sessionStats, setAttemptEvaluation, startCoachSession, takeBack, useHint } from '../src/coach/session';
import { emptyProfile, focusAreas, isMastered, recordDecision } from '../src/coach/profile';
import { buildHints, hintRevealsMove } from '../src/coach/hints';
import { assessTeachingValue, gradePrediction } from '../src/coach/prediction';
import { emptyStat, addOutcome, rating } from '../src/coach/skills';
import { evidenceFromAttempt } from '../src/services/coach';
import { res, after } from './helpers';

const mv = (u: string) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });

describe('Coach session: takebacks and learning history', () => {
  it('keeps the original mistake after a takeback and marks the retry as assisted', () => {
    let s = startCoachSession({ playerColor: 'w', coachLevel: 5, predictionEnabled: true, seed: 1 });
    expect(isPlayerTurn(s)).toBe(true);
    let r = proposeMove(s, mv('f2f3'));
    s = setAttemptEvaluation(r.state, r.attempt.id, { cls: 'mistake', epl: 12, provisional: false });
    expect(s.pending?.san).toBe('f3');
    s = takeBack(s);
    expect(s.pending).toBeNull();
    expect(s.session.moves).toEqual([]);
    s = useHint(s);
    r = proposeMove(s, mv('e2e4'));
    s = setAttemptEvaluation(r.state, r.attempt.id, { cls: 'best', epl: 0, provisional: false });
    s = commitPending(s, { cls: 'best', epl: 0, provisional: false, depth: 12 });
    expect(s.session.moves).toEqual(['e4']);
    expect(s.attempts).toHaveLength(2);
    const [first, second] = s.attempts;
    expect(first).toMatchObject({ san: 'f3', attemptNo: 1, tookBack: true, final: false, independent: true, cls: 'mistake' });
    expect(second).toMatchObject({ san: 'e4', attemptNo: 2, tookBack: false, final: true, independent: false, hintsBefore: 1 });
    expect(s.session.moveInfo[0].assisted).toBe(true);
    const st = sessionStats(s);
    expect(st.takebacks).toBe(1);
    expect(st.independentEpl).toBe(12); // the corrected move does not improve the independent record
    expect(st.finalEpl).toBe(0);
    expect(st.correctedAfterTakeback).toBe(1);
    // coach move
    expect(() => proposeMove(s, mv('d2d4'))).toThrow();
    s = commitCoachMove(s, 'e7e5', { cls: 'inaccuracy', epl: 6, provisional: true, depth: 8 });
    expect(s.session.moveInfo[1]).toMatchObject({ by: 'coach', cls: 'inaccuracy' });
    // hints for the next move start from zero
    r = proposeMove(s, mv('g1f3'));
    expect(r.attempt.independent).toBe(true);
  });

  it('restores a session from storage', () => {
    let s = startCoachSession({ playerColor: 'w', coachLevel: 5, predictionEnabled: false, seed: 1 });
    const r = proposeMove(s, mv('d2d4'));
    s = commitPending(r.state, { cls: 'book', epl: 0, provisional: false, depth: 12 });
    s = commitCoachMove(s, 'd7d5', { cls: 'book', epl: 0, provisional: false, depth: 12 });
    const back = restoreCoachState(s.session, s.attempts);
    expect(back.fens).toEqual(s.fens);
    expect(back.ucis).toEqual(['d2d4', 'd7d5']);
  });

  it('records independent and assisted evidence separately in the profile', () => {
    let p = emptyProfile();
    const fen = new Chess().fen();
    const base = { id: 'a', sessionId: 's', ply: 0, fen, attemptNo: 1, uci: 'f2f3', san: 'f3', cls: 'mistake' as const, epl: 15, provisional: false, hintsBefore: 0, tookBack: true, final: false, independent: true, ts: 0 };
    p = evidenceFromAttempt(p, base, 'e2e4', 52);
    p = evidenceFromAttempt(p, { ...base, id: 'b', attemptNo: 2, uci: 'e2e4', san: 'e4', epl: 0, tookBack: false, final: true, independent: false }, 'e2e4', 52);
    expect(p.movesIndependent).toBe(1);
    expect(p.movesAssisted).toBe(1);
    expect(p.independent.opening.n).toBe(1);
    expect(p.independent.opening.s).toBe(0);
    expect(p.assisted.opening.s).toBe(1);
    expect(p.takebacks).toBe(1);
  });

  it('reports mastery and focus areas only with enough evidence', () => {
    let p = emptyProfile();
    for (let i = 0; i < 3; i++) p = recordDecision(p, { skills: ['endgame'], outcome: 0, independent: true });
    expect(focusAreas(p)).toHaveLength(0); // 3 decisions: not enough evidence
    for (let i = 0; i < 10; i++) p = recordDecision(p, { skills: ['endgame'], outcome: 0, independent: true });
    expect(focusAreas(p)[0].skill).toBe('endgame');
    for (let i = 0; i < 40; i++) p = recordDecision(p, { skills: ['tactics'], outcome: 1, independent: true });
    expect(isMastered(p, 'tactics')).toBe(true);
    expect(isMastered(p, 'endgame')).toBe(false);
    let st = emptyStat();
    for (let i = 0; i < 6; i++) st = addOutcome(st, 0);
    for (let i = 0; i < 6; i++) st = addOutcome(st, 1);
    expect(rating(st).trend).toBeGreaterThan(0.5);
  });
});

describe('Coach hints', () => {
  const POSITIONS: { fen: string; best: string; second?: string }[] = [
    // knight fork available: Nc7+ forks king and rook
    { fen: 'r3k3/8/8/1N6/8/8/8/4K3 w q - 0 1', best: 'Nc7+' },
    // mate in one on the back rank
    { fen: '6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1', best: 'Ra8#' },
    // queen attacked: must move/defend it
    { fen: 'rnb1kbnr/pppp1ppp/8/4p1q1/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 0 1', best: 'Bxg5' },
    // quiet developing position
    { fen: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', best: 'Nf3' },
  ];
  for (const p of POSITIONS) {
    it(`never reveals the move (${p.best})`, () => {
      const fa = after(p.fen, p.best);
      void fa;
      const a = res(p.fen, [[p.best, { cp: 300 }]]);
      const hints = buildHints(p.fen, a);
      expect(hints.length).toBe(3);
      const bestUci = a.bestmove!;
      for (const h of hints) expect(hintRevealsMove(h.text, bestUci, p.best)).toBe(false);
      expect(hints.map((h) => h.level)).toEqual([1, 2, 3]);
    });
  }

  it('makes hints relevant to the position', () => {
    const fork = buildHints('r3k3/8/8/1N6/8/8/8/4K3 w q - 0 1', res('r3k3/8/8/1N6/8/8/8/4K3 w q - 0 1', [['Nc7+', { cp: 500 }]]));
    expect(fork[1].text).toMatch(/knight/);
    expect(fork[2].text).toMatch(/two important targets/);
    const threatened = 'rnb1kbnr/pppp1ppp/8/4p1q1/3P4/2N5/PPP1PPPP/R1BQKBNR w KQkq - 0 1';
    const t = buildHints(threatened, res(threatened, [['Bxg5', { cp: 900 }]]));
    expect(t[0].text).toMatch(/forcing moves|attacking/);
  });
});

describe('Predict the Opponent selection', () => {
  const history = {};
  it('skips routine opening moves', () => {
    const fen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    const a = assessTeachingValue({ fen, ply: 1, analysis: res(fen, [['e5', { cp: 30 }], ['c5', { cp: 35 }]]), pliesSinceLastExercise: 99, history, enabled: true });
    expect(a.ask).toBe(false);
  });

  it('asks before a forcing tactic and respects the cooldown and the toggle', () => {
    // Coach (black) to move, Qh4# available
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq g3 0 2';
    const analysis = res(fen, [['Qh4#', { mate: -1 }], ['d5', { cp: -50 }]]);
    const a = assessTeachingValue({ fen, ply: 25, analysis, pliesSinceLastExercise: 99, history, enabled: true });
    expect(a.ask).toBe(true);
    expect(a.category).toBe('mate');
    expect(assessTeachingValue({ fen, ply: 25, analysis, pliesSinceLastExercise: 2, history, enabled: true }).ask).toBe(false);
    expect(assessTeachingValue({ fen, ply: 25, analysis, pliesSinceLastExercise: 99, history, enabled: false }).ask).toBe(false);
  });

  it('asks less often about patterns the player reliably anticipates', () => {
    const fen = 'r3k3/8/8/1N6/8/8/8/4K3 w q - 0 1';
    const analysis = res(fen, [['Nc7+', { cp: 500 }], ['Kd2', { cp: 0 }]]);
    const fresh = assessTeachingValue({ fen, ply: 40, analysis, pliesSinceLastExercise: 99, history: {}, enabled: true });
    let mastered = emptyStat();
    for (let i = 0; i < 30; i++) mastered = addOutcome(mastered, 1);
    const known = assessTeachingValue({ fen, ply: 40, analysis, pliesSinceLastExercise: 99, history: { tactic: mastered }, enabled: true });
    expect(known.score).toBeLessThan(fresh.score);
  });

  it('grades predictions fairly when several replies are strong', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const analysis = res(fen, [['Nf3', { cp: 35 }], ['Nc3', { cp: 30 }], ['Qh5', { cp: -40 }]]);
    const exact = gradePrediction(fen, 'g1f3', 'g1f3', analysis);
    expect(exact.grade).toBe('exact');
    const alt = gradePrediction(fen, 'b1c3', 'g1f3', analysis);
    expect(alt.grade).toBe('strong');
    const weak = gradePrediction(fen, 'a2a3', 'g1f3', analysis, 30);
    expect(weak.grade).toBe('missed');
    expect(gradePrediction(fen, null, 'g1f3', analysis).grade).toBe('skipped');
  });
});
