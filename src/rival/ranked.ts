import { Chess } from 'chess.js';
import { createClock, isTimed, pressClock, remainingMs, startClock, type ClockState, type TimeControl } from '../chess/clock';
import { gameStatus, resignResult, timeoutResult, type DrawClaim, type EndReason, type GameResult } from '../chess/rules';
import { START_FEN } from '../chess/tree';
import type { RankedMatch, RankedProfile } from '../db/types';
import { levelForRating, levelRating } from '../engine/strength';
import { newId } from '../util/id';
import { INITIAL_RATING, RIVAL_RD, updateRating, decayRd } from './glicko';
import { NEUTRAL_STRATEGY, type RivalStrategy } from './policy';

/**
 * Ranked match rules (pure). The Rival's strength level and strategy are
 * fixed when the match is created and cannot change during the game.
 */
export interface RankedState {
  match: RankedMatch;
  fens: string[];
  clock: ClockState;
}

export function emptyRankedProfile(): RankedProfile {
  return { id: 'ranked', rating: { ...INITIAL_RATING }, history: [], wins: 0, draws: 0, losses: 0 };
}

/** Choose the Rival level for the player's current rating (nearest anchor → expected score ≈ 50%). */
export function rivalLevelFor(profile: RankedProfile): number {
  return levelForRating(profile.rating.r);
}

export function createMatch(opts: { playerColor: 'w' | 'b'; rivalLevel: number; timeControl: TimeControl; strategy?: RivalStrategy; seed?: number; now?: number }): RankedState {
  const now = opts.now ?? Date.now();
  const match: RankedMatch = {
    id: newId('rk'), playerColor: opts.playerColor, rivalLevel: opts.rivalLevel, rivalRating: levelRating(opts.rivalLevel),
    timeControl: opts.timeControl, startFen: START_FEN, moves: [], ucis: [], timeSpent: [], clockAfter: [], status: 'active', result: '*',
    strategy: opts.strategy ?? NEUTRAL_STRATEGY, rivalNotes: [], seed: opts.seed ?? Math.floor(Math.random() * 2 ** 31), analysisDone: false,
    createdAt: now, updatedAt: now,
  };
  const clock = startClock(createClock(opts.timeControl), 'w', now);
  return { match: { ...match, clock: snapshotClock(clock) }, fens: [START_FEN], clock };
}

const snapshotClock = (c: ClockState) => ({ remaining: { ...c.remaining }, running: c.running, since: c.since });

export function restoreRanked(match: RankedMatch): RankedState {
  const c = new Chess(match.startFen);
  const fens = [match.startFen];
  for (const s of match.moves) { c.move(s); fens.push(c.fen()); }
  const base = createClock(match.timeControl);
  const clock: ClockState = match.clock ? { ...base, remaining: { ...match.clock.remaining }, running: match.clock.running, since: match.clock.since } : base;
  return { match, fens, clock };
}

export const rankedFen = (s: RankedState) => s.fens[s.fens.length - 1];

function end(s: RankedState, result: GameResult, reason: EndReason, now: number): RankedState {
  const clock = { ...s.clock, remaining: { w: remainingMs(s.clock, 'w', now), b: remainingMs(s.clock, 'b', now) }, running: null };
  return { ...s, clock, match: { ...s.match, status: 'finished', result, reason, clock: snapshotClock(clock), updatedAt: now } };
}

/** Play a move for whichever side is to move. Enforces turn, legality and the clock. */
export function playRankedMove(s: RankedState, move: string | { from: string; to: string; promotion?: string }, now: number, note?: string[]): RankedState {
  if (s.match.status !== 'active') throw new Error('The match is over.');
  const fen = rankedFen(s);
  const c = new Chess(fen);
  const mover = c.turn();
  const flagged = checkFlag(s, now);
  if (flagged.match.status !== 'active') return flagged;
  const mv = typeof move === 'string' && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)
    ? c.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move[4] })
    : c.move(move as never);
  const press = pressClock(s.clock, mover, now);
  if (press.flagged) {
    const t = timeoutResult(fen, mover);
    return end({ ...s, clock: press.clock }, t.result, t.reason, now);
  }
  const fens = [...s.fens, c.fen()];
  const uci = mv.from + mv.to + (mv.promotion ?? '');
  let match: RankedMatch = {
    ...s.match,
    moves: [...s.match.moves, mv.san],
    ucis: [...s.match.ucis, uci],
    timeSpent: [...s.match.timeSpent, press.spentMs],
    clockAfter: [...s.match.clockAfter, isTimed(press.clock) ? press.clock.remaining[mover] : -1],
    clock: snapshotClock(press.clock),
    rivalNotes: note && mover !== s.match.playerColor ? [...s.match.rivalNotes, { ply: s.match.moves.length, san: mv.san, reasons: note }] : s.match.rivalNotes,
    drawOfferedByPlayerAtPly: undefined,
    updatedAt: now,
  };
  let next: RankedState = { ...s, match, fens, clock: press.clock };
  const st = gameStatus(fens);
  if (st.over) next = end(next, st.result, st.reason!, now);
  match = next.match;
  return next;
}

/** End the game if the side to move has run out of time. */
export function checkFlag(s: RankedState, now: number): RankedState {
  if (s.match.status !== 'active' || !isTimed(s.clock) || !s.clock.running) return s;
  const side = s.clock.running;
  if (remainingMs(s.clock, side, now) > 0) return s;
  const t = timeoutResult(rankedFen(s), side);
  return end(s, t.result, t.reason, now);
}

export function resignRanked(s: RankedState, now: number): RankedState {
  if (s.match.status !== 'active') return s;
  const r = resignResult(s.match.playerColor);
  return end(s, r.result, r.reason, now);
}

export function claimDraw(s: RankedState, claim: DrawClaim, now: number): RankedState {
  const st = gameStatus(s.fens);
  if (!st.claimable.includes(claim)) throw new Error('That draw cannot be claimed in this position.');
  return end(s, '1/2-1/2', claim, now);
}

export function agreeDraw(s: RankedState, now: number): RankedState {
  return end(s, '1/2-1/2', 'agreement', now);
}

/**
 * Does the Rival accept a draw offer? Decided from its own evaluation (win%
 * from the Rival's side). The rule is fixed and documented: it accepts when
 * it is not better (≤ 50%) after move 20, or the game is dead equal (45–55%)
 * after move 40.
 */
export function rivalAcceptsDraw(rivalWin: number, ply: number): boolean {
  if (ply >= 40 && rivalWin <= 50) return true;
  if (ply >= 80 && rivalWin <= 55) return true;
  return false;
}

export function playerScore(match: RankedMatch): number | null {
  if (match.result === '*') return null;
  if (match.result === '1/2-1/2') return 0.5;
  const whiteWon = match.result === '1-0';
  return (whiteWon && match.playerColor === 'w') || (!whiteWon && match.playerColor === 'b') ? 1 : 0;
}

/** Apply a finished match to the Ranked profile (Glicko-2 update). */
export function applyResult(profile: RankedProfile, match: RankedMatch, now = Date.now()): { profile: RankedProfile; match: RankedMatch } {
  const score = playerScore(match);
  if (score === null || match.ratingAfter) return { profile, match };
  const idleDays = profile.lastPlayed ? (now - profile.lastPlayed) / 86400000 : 0;
  const before = decayRd(profile.rating, idleDays);
  const after = updateRating(before, { r: match.rivalRating, rd: RIVAL_RD }, score);
  const p: RankedProfile = {
    ...profile,
    rating: after,
    history: [...profile.history, { ts: now, matchId: match.id, r: after.r, rd: after.rd, result: score, rivalLevel: match.rivalLevel }],
    wins: profile.wins + (score === 1 ? 1 : 0),
    draws: profile.draws + (score === 0.5 ? 1 : 0),
    losses: profile.losses + (score === 0 ? 1 : 0),
    lastPlayed: now,
  };
  return { profile: p, match: { ...match, ratingBefore: before, ratingAfter: after } };
}
