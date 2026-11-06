import type { Color } from 'chess.js';

export interface TimeControl {
  /** initial time per side in seconds; 0 = untimed */
  initial: number;
  /** Fischer increment in seconds */
  increment: number;
}

export const TIME_CONTROLS: { id: string; label: string; tc: TimeControl }[] = [
  { id: '3+2', label: '3 + 2 (blitz)', tc: { initial: 180, increment: 2 } },
  { id: '5+3', label: '5 + 3 (blitz)', tc: { initial: 300, increment: 3 } },
  { id: '10+5', label: '10 + 5 (rapid)', tc: { initial: 600, increment: 5 } },
  { id: '15+10', label: '15 + 10 (rapid)', tc: { initial: 900, increment: 10 } },
  { id: '30+20', label: '30 + 20 (classical)', tc: { initial: 1800, increment: 20 } },
  { id: 'untimed', label: 'Untimed', tc: { initial: 0, increment: 0 } },
];

/**
 * Pure chess clock state. All functions take `now` (ms) so behaviour is
 * deterministic and testable. Times are stored in milliseconds.
 */
export interface ClockState {
  tc: TimeControl;
  remaining: { w: number; b: number };
  running: Color | null;
  /** timestamp when the running side's clock last started */
  since: number;
}

export function createClock(tc: TimeControl): ClockState {
  return { tc, remaining: { w: tc.initial * 1000, b: tc.initial * 1000 }, running: null, since: 0 };
}

export function isTimed(c: ClockState) {
  return c.tc.initial > 0;
}

export function remainingMs(c: ClockState, color: Color, now: number): number {
  if (!isTimed(c)) return Infinity;
  const base = c.remaining[color];
  return c.running === color ? Math.max(0, base - (now - c.since)) : base;
}

export function startClock(c: ClockState, color: Color, now: number): ClockState {
  return { ...c, running: color, since: now };
}

/**
 * The side to move completes its move: its elapsed time is deducted, the
 * increment is added (only if it has not flagged) and the opponent's clock starts.
 */
export function pressClock(c: ClockState, mover: Color, now: number): { clock: ClockState; flagged: boolean; spentMs: number } {
  if (!isTimed(c)) return { clock: { ...c, running: mover === 'w' ? 'b' : 'w', since: now }, flagged: false, spentMs: c.running === mover ? now - c.since : 0 };
  const spent = c.running === mover ? now - c.since : 0;
  const left = c.remaining[mover] - spent;
  if (left <= 0) {
    return { clock: { ...c, remaining: { ...c.remaining, [mover]: 0 }, running: null }, flagged: true, spentMs: spent };
  }
  const next: Color = mover === 'w' ? 'b' : 'w';
  return {
    clock: { ...c, remaining: { ...c.remaining, [mover]: left + c.tc.increment * 1000 }, running: next, since: now },
    flagged: false,
    spentMs: spent,
  };
}

export function stopClock(c: ClockState, now: number): ClockState {
  if (!c.running) return c;
  const color = c.running;
  return { ...c, remaining: { ...c.remaining, [color]: remainingMs(c, color, now) }, running: null };
}

export function flaggedSide(c: ClockState, now: number): Color | null {
  if (!isTimed(c) || !c.running) return null;
  return remainingMs(c, c.running, now) <= 0 ? c.running : null;
}

export function formatClock(ms: number): string {
  if (!isFinite(ms)) return '∞';
  const total = Math.max(0, ms);
  const s = Math.floor(total / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (total < 10000) return `${m}:${String(sec).padStart(2, '0')}.${Math.floor((total % 1000) / 100)}`;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
