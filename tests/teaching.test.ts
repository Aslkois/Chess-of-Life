import { Chess } from 'chess.js';
import {
  canRewind, commitCoachMove, commitPending, currentFen, isPlayerTurn, markDemoSeen, proposeMove, recordHint, resignCoach, restoreCoachState,
  rewind, sessionStats, setAttemptEvaluation, startCoachSession, takeBack, type CoachState,
} from '../src/coach/session';
import { classifyMove, type MoveContext } from '../src/analysis/classify';
import { teachMove, isNotable } from '../src/coach/teach';
import { after, res, uci } from './helpers';

const mv = (u: string) => ({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
const ok = { cls: 'best' as const, epl: 0, provisional: false, depth: 12 };

/** play a player move (committed) */
function play(s: CoachState, u: string, info: { cls: 'best' | 'blunder' | 'good' | 'mistake'; epl: number } = { cls: 'best', epl: 0 }) {
  const r = proposeMove(s, mv(u));
  const e = setAttemptEvaluation(r.state, r.attempt.id, { ...info, provisional: false });
  return commitPending(e, { ...info, provisional: false, depth: 12 });
}

describe('Coach takebacks: unlimited, any move, any time', () => {
  it('takes back a good move as well as a bad one, with no limit', () => {
    let s = startCoachSession({ playerColor: 'w', coachLevel: 5, predictionEnabled: false, seed: 1 });
    expect(canRewind(s)).toBe(false);
    for (let i = 0; i < 25; i++) {
      s = play(s, 'e2e4'); // a perfectly good move
      expect(canRewind(s)).toBe(true);
      s = rewind(s);
      expect(s.ucis).toEqual([]);
      expect(isPlayerTurn(s)).toBe(true);
    }
    expect(sessionStats(s).takebacks).toBe(25);
    expect(s.attempts.filter((a) => a.rewound)).toHaveLength(25);
  });

  it('undoes the Coach reply with the player move, and repeats to go further back', () => {
    let s = startCoachSession({ playerColor: 'w', coachLevel: 5, predictionEnabled: false, seed: 1 });
    s = play(s, 'e2e4');
    s = commitCoachMove(s, 'e7e5', ok);
    s = play(s, 'g1f3');
    s = commitCoachMove(s, 'b8c6', ok);
    s = play(s, 'f1c4');
    s = commitCoachMove(s, 'g8f6', ok);
    expect(s.session.moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Nf6']);
    s = rewind(s);
    expect(s.session.moves).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(isPlayerTurn(s)).toBe(true);
    s = rewind(s);
    s = rewind(s);
    expect(s.session.moves).toEqual([]);
    expect(currentFen(s)).toBe(new Chess().fen());
    expect(s.session.moveInfo).toEqual([]);
  });

  it('takes back a move while the Coach has not replied yet', () => {
    let s = startCoachSession({ playerColor: 'w', coachLevel: 5, predictionEnabled: false, seed: 1 });
    s = play(s, 'd2d4');
    expect(isPlayerTurn(s)).toBe(false); // Coach to move
    s = rewind(s);
    expect(s.session.moves).toEqual([]);
    expect(isPlayerTurn(s)).toBe(true);
  });

  it('takes back a pending move under evaluation', () => {
    let s = startCoachSession({ playerColor: 'w', coachLevel: 5, predictionEnabled: false, seed: 1 });
    const r = proposeMove(s, mv('f2f3'));
    s = rewind(r.state);
    expect(s.pending).toBeNull();
    expect(s.attempts[0].tookBack).toBe(true);
  });

  it('works after the game ended: checkmate and resignation', () => {
    // Fool's mate with the player as Black: the Coach (White) plays f3 and g4
    let s = startCoachSession({ playerColor: 'b', coachLevel: 5, predictionEnabled: false, seed: 1 });
    s = commitCoachMove(s, 'f2f3', ok);
    s = play(s, 'e7e5');
    s = commitCoachMove(s, 'g2g4', ok);
    s = play(s, 'd8h4');
    expect(s.session.status).toBe('finished');
    expect(s.session.result).toBe('0-1');
    expect(canRewind(s)).toBe(true);
    s = rewind(s);
    expect(s.session.status).toBe('active');
    expect(s.session.result).toBe('*');
    expect(s.session.moves).toEqual(['f3', 'e5', 'g4']);
    expect(isPlayerTurn(s)).toBe(true);
    // resign, then take back
    s = resignCoach(s);
    expect(s.session.status).toBe('finished');
    s = rewind(s);
    expect(s.session.status).toBe('active');
    expect(s.session.reason).toBeUndefined();
    expect(s.session.moves).toEqual(['f3']);
  });

  it('lets the player replay a different continuation', () => {
    let s = startCoachSession({ playerColor: 'w', coachLevel: 5, predictionEnabled: false, seed: 1 });
    s = play(s, 'e2e4');
    s = commitCoachMove(s, 'e7e5', ok);
    s = rewind(s);
    s = play(s, 'd2d4');
    s = commitCoachMove(s, 'd7d5', ok);
    expect(s.session.moves).toEqual(['d4', 'd5']);
    // the log keeps both decisions at the start position; the replay is assisted
    const atStart = s.attempts.filter((a) => a.ply === 0);
    expect(atStart.map((a) => [a.san, a.independent, !!a.rewound, a.final])).toEqual([['e4', true, true, true], ['d4', false, false, true]]);
    expect(s.session.moveInfo[0].assisted).toBe(true);
  });

  it('keeps learning integrity: only first, unassisted decisions count as independent', () => {
    let s = startCoachSession({ playerColor: 'w', coachLevel: 5, predictionEnabled: false, seed: 1 });
    s = play(s, 'f2f3', { cls: 'mistake', epl: 14 });
    s = commitCoachMove(s, 'e7e5', ok);
    s = play(s, 'g2g4', { cls: 'blunder', epl: 60 });
    s = rewind(s); // after the Coach's reply (none yet) – back to before g4
    s = play(s, 'e2e3', { cls: 'good', epl: 3 });
    const st = sessionStats(s);
    expect(st.independentDecisions).toBe(2); // f3 and g4: the first tries
    expect(st.independentEpl).toBe(37); // (14 + 60) / 2 – the correction does not improve it
    expect(st.takebacks).toBe(1);
    const e3 = s.attempts.find((a) => a.san === 'e3')!;
    expect(e3.independent).toBe(false);
    expect(e3.attemptNo).toBe(2);
    // a hint makes the next decision assisted too
    s = commitCoachMove(s, 'd8h4', ok);
    s = recordHint(s);
    const r = proposeMove(s, mv('e1e2'));
    expect(r.attempt.independent).toBe(false);
    expect(r.attempt.hintsBefore).toBe(1);
  });

  it('recognises the same position reached by a different move order', () => {
    let s = startCoachSession({ playerColor: 'w', coachLevel: 5, predictionEnabled: false, seed: 1 });
    s = play(s, 'g1f3');
    s = commitCoachMove(s, 'g8f6', ok);
    s = play(s, 'd2d4');
    s = commitCoachMove(s, 'd7d5', ok);
    s = play(s, 'c2c4'); // first decision in the position after 1.Nf3 Nf6 2.d4 d5
    s = rewind(s); s = rewind(s); s = rewind(s);
    expect(s.ucis).toEqual([]);
    s = play(s, 'd2d4');
    s = commitCoachMove(s, 'd7d5', ok);
    s = play(s, 'g1f3');
    s = commitCoachMove(s, 'g8f6', ok);
    // same position as before c4 was tried: not an independent decision any more
    const r = proposeMove(s, mv('c2c4'));
    expect(r.attempt.independent).toBe(false);
  });

  it('records which attempts the player studied a demonstration for, and restores from storage', () => {
    let s = startCoachSession({ playerColor: 'w', coachLevel: 5, predictionEnabled: false, seed: 1 });
    const r = proposeMove(s, mv('f2f3'));
    s = markDemoSeen(r.state, r.attempt.id);
    s = takeBack(s);
    expect(s.attempts[0].sawDemo).toBe(true);
    s = play(s, 'e2e4');
    s = commitCoachMove(s, 'e7e5', ok);
    s = rewind(s);
    const back = restoreCoachState(s.session, s.attempts);
    expect(back.ucis).toEqual([]);
    expect(back.attempts.map((a) => a.san)).toEqual(['f3', 'e4']);
  });
});

// ---------------- post-move teaching ----------------

type S = { cp?: number; mate?: number };
function classified(fen: string, played: string, lines: [string, S][], afterScore: S, reply: string[], extra: Partial<MoveContext> = {}) {
  const fa = after(fen, played);
  const c = new Chess(fen);
  const replyUcis: string[] = [];
  const cc = new Chess(fa);
  for (const m of reply) { const x = cc.move(m); replyUcis.push(x.from + x.to + (x.promotion ?? '')); }
  const term = new Chess(fa).moves().length === 0;
  const ctx: MoveContext = {
    fenBefore: fen, uci: uci(fen, played), color: c.turn(), before: res(fen, lines),
    after: term ? { ...res(fa, []), lines: [{ multipv: 1, depth: 999, score: afterScore, pv: [] }], depth: 999 } : { ...res(fa, []), bestmove: replyUcis[0] ?? null, lines: [{ multipv: 1, depth: 16, score: afterScore, pv: replyUcis }] },
    legalMoves: c.moves().length, targetDepth: 16, ...extra,
  };
  const cls = classifyMove(ctx);
  // a longer best line for the demonstration
  return { cls, replyUcis };
}

describe('Post-move teaching is specific and never invented', () => {
  const E4E5NF3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2';

  it('explains a hanging queen with the piece, the squares and the capture', () => {
    const { cls, replyUcis } = classified(E4E5NF3, 'Qh4', [['Nc6', { cp: 30 }], ['d6', { cp: 40 }]], { cp: 900 }, ['Nxh4', 'Nf6', 'd3']);
    expect(cls.cls).toBe('blunder');
    const t = teachMove({ fenBefore: E4E5NF3, uci: uci(E4E5NF3, 'Qh4'), c: cls, cls: cls.cls, afterPv: replyUcis, ply: 3 });
    expect(t.kind).toBe('tactical');
    expect(t.tone).toBe('bad');
    const text = t.points.map((p) => p.text).join(' ');
    expect(text).toMatch(/On h4 your queen is attacked by the knight on f3 and not defended at all: Nxh4 wins it for nothing/);
    expect(text).toMatch(/knight on f3/);
    expect(text).toMatch(/Nxh4/);
    const hanging = t.points.find((p) => /On h4 your queen/.test(p.text))!;
    expect(hanging.mark?.arrows).toContainEqual(['f3', 'h4', 'threat']);
    expect(hanging.mark?.squares).toContainEqual(['h4', 'threat']);
    // Show Why demonstrates the punishment from the position after the move
    expect(t.why).not.toBeNull();
    expect(t.why!.startFen).toBe(after(E4E5NF3, 'Qh4'));
    expect(t.why!.steps[0]).toMatchObject({ san: 'Nxh4', by: 'opponent' });
    expect(t.why!.steps[0].mark.arrows[0]).toEqual(['f3', 'h4', 'threat']);
    expect(t.why!.summary).toMatch(/down/);
    // Best Move and Compare start from the position before the move
    expect(t.best!.title).toBe('Better was Nc6');
    expect(t.best!.startFen).toBe(E4E5NF3);
    expect(t.best!.startMark.arrows[0]).toEqual(['b8', 'c6', 'better']);
    expect(t.compare!.played.san).toBe('Qh4');
    expect(t.compare!.best.san).toBe('Nc6');
    expect(t.compare!.best.win).toBeGreaterThan(t.compare!.played.win);
  });

  it('explains a positional error without inventing a tactic', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';
    const { cls, replyUcis } = classified(fen, 'Ke2', [['Nf3', { cp: 35 }], ['Nc3', { cp: 30 }]], { cp: -45 }, ['Nc6', 'd3', 'Nf6']);
    expect(['inaccuracy', 'mistake']).toContain(cls.cls);
    const t = teachMove({ fenBefore: fen, uci: uci(fen, 'Ke2'), c: cls, cls: cls.cls, afterPv: replyUcis, ply: 2 });
    expect(t.kind).toBe('positional');
    const text = t.points.map((p) => p.text).join(' ');
    expect(text).toMatch(/right to castle/);
    expect(text).not.toMatch(/fork|wins it|checkmate|hanging|takes your/i);
    expect(t.why!.intro).toMatch(/No forcing tactic/);
  });

  it('says so honestly when there is no concrete reason it can name', () => {
    const fen = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const { cls, replyUcis } = classified(fen, 'a3', [['O-O', { cp: 40 }], ['d3', { cp: 35 }]], { cp: -20 }, ['Nxe4', 'Nc3', 'Nxc3']);
    expect(['inaccuracy', 'mistake']).toContain(cls.cls);
    const t = teachMove({ fenBefore: fen, uci: uci(fen, 'a3'), c: cls, cls: cls.cls, afterPv: replyUcis, ply: 6 });
    const text = t.points.map((p) => p.text).join(' ');
    // Nxe4 takes a pawn: that is a fact from the line; no fork or mate is claimed
    expect(text).toMatch(/Nxe4 takes your pawn on e4/);
    expect(text).not.toMatch(/fork|checkmate/i);
  });

  it('names the forced mate a move allows', () => {
    const fen = 'rnbqkbnr/pppp1ppp/8/4p3/8/5P2/PPPPP1PP/RNBQKBNR w KQkq - 0 2';
    const { cls, replyUcis } = classified(fen, 'g4', [['e4', { cp: -60 }], ['Nc3', { cp: -70 }]], { mate: -1 }, ['Qh4#']);
    expect(cls.cls).toBe('blunder');
    const t = teachMove({ fenBefore: fen, uci: uci(fen, 'g4'), c: cls, cls: cls.cls, afterPv: replyUcis, ply: 2 });
    expect(t.kind).toBe('mate');
    expect(t.points.map((p) => p.text).join(' ')).toMatch(/Qh4#, which is checkmate/);
    expect(t.why!.summary).toBe('The line ends in checkmate against you.');
  });

  it('reinforces a genuinely notable good move and stays quiet about routine ones', () => {
    const forkFen = 'r3k3/8/8/1N6/8/8/8/4K3 w q - 0 1';
    const f = classified(forkFen, 'Nc7+', [['Nc7+', { cp: 500 }], ['Kd2', { cp: 0 }]], { cp: 500 }, ['Kd7', 'Nxa8']);
    const t = teachMove({ fenBefore: forkFen, uci: uci(forkFen, 'Nc7+'), c: f.cls, cls: f.cls.cls, afterPv: f.replyUcis, ply: 40 });
    expect(['great', 'best']).toContain(f.cls.cls);
    expect(t.points.map((p) => p.text).join(' ')).toMatch(/fork/i);
    expect(isNotable(t, f.cls.cls)).toBe(true);
    expect(t.best).toBeNull(); // the better move is only offered for errors
    expect(t.compare).toBeNull();

    const quiet = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4';
    const q = classified(quiet, 'd3', [['d3', { cp: 30 }], ['O-O', { cp: 29 }], ['Nc3', { cp: 28 }]], { cp: 30 }, ['Bc5']);
    const tq = teachMove({ fenBefore: quiet, uci: uci(quiet, 'd3'), c: q.cls, cls: q.cls.cls, afterPv: q.replyUcis, ply: 6 });
    expect(isNotable(tq, q.cls.cls)).toBe(false);
  });
});
