import { Chess } from 'chess.js';
import { newId } from '../util/id';
import type { CoachAttempt, CoachMoveInfo, CoachSession } from '../db/types';
import type { MoveClassification } from '../analysis/classify';
import { START_FEN } from '../chess/tree';
import { gameStatus } from '../chess/rules';

/**
 * Coach game state. Pure functions: the React page and the tests drive the
 * same logic. Attempts are kept as an append-only log, so a takeback never
 * erases the evidence of the original decision.
 */
export interface CoachState {
  session: CoachSession;
  /** FEN after each committed ply; [0] = start */
  fens: string[];
  ucis: string[];
  /** the player's move that is shown but not yet committed (awaiting feedback) */
  pending: { attemptId: string; uci: string; san: string; fenAfter: string } | null;
  attempts: CoachAttempt[];
  hintsThisMove: number;
  attemptNoThisMove: number;
}

export function startCoachSession(opts: { playerColor: 'w' | 'b'; coachLevel: number; predictionEnabled: boolean; seed?: number; startFen?: string }): CoachState {
  const now = Date.now();
  const startFen = opts.startFen ?? START_FEN;
  return {
    session: {
      id: newId('cs'), playerColor: opts.playerColor, coachLevel: opts.coachLevel, predictionEnabled: opts.predictionEnabled, startFen,
      moves: [], moveInfo: [], hintsUsed: 0, takebacks: 0, lastExercisePly: -100, status: 'active', result: '*',
      seed: opts.seed ?? Math.floor(Math.random() * 2 ** 31), createdAt: now, updatedAt: now,
    },
    fens: [startFen], ucis: [], pending: null, attempts: [], hintsThisMove: 0, attemptNoThisMove: 1,
  };
}

export const currentFen = (s: CoachState) => s.fens[s.fens.length - 1];
export const sideToMove = (s: CoachState) => new Chess(currentFen(s)).turn();
export const isPlayerTurn = (s: CoachState) => s.session.status === 'active' && !s.pending && sideToMove(s) === s.session.playerColor;

/** The player tries a move. It is recorded as an attempt and shown, but not committed. */
export function proposeMove(s: CoachState, move: { from: string; to: string; promotion?: string }): { state: CoachState; attempt: CoachAttempt } {
  if (!isPlayerTurn(s)) throw new Error('Not your turn.');
  const c = new Chess(currentFen(s));
  const mv = c.move(move); // throws on illegal moves
  const uci = mv.from + mv.to + (mv.promotion ?? '');
  const attempt: CoachAttempt = {
    id: newId('at'), sessionId: s.session.id, ply: s.ucis.length, fen: currentFen(s), attemptNo: s.attemptNoThisMove, uci, san: mv.san,
    cls: null, epl: null, provisional: true, hintsBefore: s.hintsThisMove, tookBack: false, final: false,
    independent: s.attemptNoThisMove === 1 && s.hintsThisMove === 0, ts: Date.now(),
  };
  return { state: { ...s, pending: { attemptId: attempt.id, uci, san: mv.san, fenAfter: c.fen() }, attempts: [...s.attempts, attempt] }, attempt };
}

export function setAttemptEvaluation(s: CoachState, attemptId: string, c: Pick<MoveClassification, 'cls' | 'epl' | 'provisional'>): CoachState {
  return { ...s, attempts: s.attempts.map((a) => (a.id === attemptId ? { ...a, cls: c.cls, epl: c.epl, provisional: c.provisional } : a)) };
}

/** Undo the pending attempt. The attempt stays in the log, marked as taken back. */
export function takeBack(s: CoachState): CoachState {
  if (!s.pending) throw new Error('Nothing to take back.');
  const id = s.pending.attemptId;
  return {
    ...s,
    pending: null,
    attempts: s.attempts.map((a) => (a.id === id ? { ...a, tookBack: true } : a)),
    attemptNoThisMove: s.attemptNoThisMove + 1,
    session: { ...s.session, takebacks: s.session.takebacks + 1, updatedAt: Date.now() },
  };
}

function commit(s: CoachState, uci: string, info: Omit<CoachMoveInfo, 'ply' | 'san' | 'uci' | 'color'>): CoachState {
  const fen = currentFen(s);
  const c = new Chess(fen);
  const color = c.turn();
  const mv = c.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
  const fens = [...s.fens, c.fen()];
  const status = gameStatus(fens);
  const session: CoachSession = {
    ...s.session,
    moves: [...s.session.moves, mv.san],
    moveInfo: [...s.session.moveInfo, { ply: s.ucis.length, san: mv.san, uci, color, ...info }],
    updatedAt: Date.now(),
    ...(status.over ? { status: 'finished' as const, result: status.result, reason: status.reason } : {}),
  };
  return { ...s, session, fens, ucis: [...s.ucis, uci] };
}

/** Accept the pending move ("Continue") and play it. */
export function commitPending(s: CoachState, info: { cls: CoachMoveInfo['cls']; epl: number | null; provisional: boolean; depth: number }): CoachState {
  if (!s.pending) throw new Error('No pending move.');
  const p = s.pending;
  const attempt = s.attempts.find((a) => a.id === p.attemptId)!;
  const next = commit({ ...s, pending: null }, p.uci, { by: 'player', ...info, assisted: !attempt.independent });
  return {
    ...next,
    attempts: next.attempts.map((a) => (a.id === p.attemptId ? { ...a, final: true } : a)),
    hintsThisMove: 0,
    attemptNoThisMove: 1,
  };
}

export function commitCoachMove(s: CoachState, uci: string, info: { cls: CoachMoveInfo['cls']; epl: number | null; provisional: boolean; depth: number }): CoachState {
  if (s.session.status !== 'active' || sideToMove(s) === s.session.playerColor) throw new Error('Not the Coach’s turn.');
  return commit(s, uci, { by: 'coach', ...info, assisted: false });
}

export function useHint(s: CoachState): CoachState {
  return { ...s, hintsThisMove: s.hintsThisMove + 1, session: { ...s.session, hintsUsed: s.session.hintsUsed + 1, updatedAt: Date.now() } };
}

export function updateMoveInfo(s: CoachState, ply: number, patch: Partial<CoachMoveInfo>): CoachState {
  return { ...s, session: { ...s.session, moveInfo: s.session.moveInfo.map((m) => (m.ply === ply ? { ...m, ...patch } : m)) } };
}

export function resignCoach(s: CoachState): CoachState {
  return { ...s, pending: null, session: { ...s.session, status: 'finished', result: s.session.playerColor === 'w' ? '0-1' : '1-0', reason: 'resignation', updatedAt: Date.now() } };
}

/** Summary of independent vs assisted performance in a session. */
export function sessionStats(s: CoachState) {
  const firsts = s.attempts.filter((a) => a.attemptNo === 1);
  const independent = s.attempts.filter((a) => a.independent && a.epl !== null);
  const assistedFinal = s.attempts.filter((a) => a.final && !a.independent);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  return {
    decisions: firsts.length,
    independentDecisions: independent.length,
    takebacks: s.attempts.filter((a) => a.tookBack).length,
    hints: s.session.hintsUsed,
    independentEpl: mean(independent.map((a) => a.epl!)),
    finalEpl: mean(s.attempts.filter((a) => a.final && a.epl !== null).map((a) => a.epl!)),
    correctedAfterTakeback: assistedFinal.filter((a) => (a.epl ?? 99) < 5).length,
  };
}

export function restoreCoachState(session: CoachSession, attempts: CoachAttempt[]): CoachState {
  const fens = [session.startFen];
  const ucis: string[] = [];
  const c = new Chess(session.startFen);
  for (const san of session.moves) {
    const m = c.move(san);
    ucis.push(m.from + m.to + (m.promotion ?? ''));
    fens.push(c.fen());
  }
  const ply = ucis.length;
  const here = attempts.filter((a) => a.ply === ply && !a.final);
  return {
    session, fens, ucis, pending: null, attempts: attempts.sort((a, b) => a.ts - b.ts),
    hintsThisMove: 0, attemptNoThisMove: here.length + 1,
  };
}
