/**
 * Playback state of a demonstration line (Show Why / Best Move): automatic
 * play at a chosen speed plus manual move-by-move navigation. Any manual step
 * pauses playback; when the end is reached playback stops and the line stays
 * on the board.
 */
export type ReplaySpeed = 0.5 | 1 | 2;
export interface ReplayState { length: number; step: number; playing: boolean; speed: ReplaySpeed }
export type ReplayAction =
  | { t: 'first' } | { t: 'prev' } | { t: 'next' } | { t: 'last' } | { t: 'goto'; step: number }
  | { t: 'toggle' } | { t: 'replay' } | { t: 'tick' } | { t: 'speed'; speed: ReplaySpeed };

const clamp = (s: ReplayState, n: number) => Math.max(0, Math.min(s.length, n));

export function startReplay(length: number, speed: ReplaySpeed = 1, autoplay = true): ReplayState {
  return { length, step: 0, playing: autoplay && length > 0, speed };
}

export function replayReducer(s: ReplayState, a: ReplayAction): ReplayState {
  switch (a.t) {
    case 'first': return { ...s, step: 0, playing: false };
    case 'prev': return { ...s, step: clamp(s, s.step - 1), playing: false };
    case 'next': return { ...s, step: clamp(s, s.step + 1), playing: false };
    case 'last': return { ...s, step: s.length, playing: false };
    case 'goto': return { ...s, step: clamp(s, a.step), playing: false };
    case 'toggle':
      if (s.playing) return { ...s, playing: false };
      return s.step >= s.length ? { ...s, step: 0, playing: s.length > 0 } : { ...s, playing: true };
    case 'replay': return { ...s, step: 0, playing: s.length > 0 };
    case 'tick': {
      if (!s.playing) return s;
      const step = clamp(s, s.step + 1);
      return { ...s, step, playing: step < s.length };
    }
    case 'speed': return { ...s, speed: a.speed };
  }
}

/** Delay before the next automatic step. */
export function tickMs(s: ReplayState): number {
  return (s.step === 0 ? 700 : 1100) / s.speed;
}

/** Move number label for half-move `i` (0-based) of a line starting at `fen`. */
export function moveLabel(fen: string, i: number): { no: number; white: boolean; label: string } {
  const parts = fen.split(' ');
  const full = Number(parts[5] ?? 1) || 1;
  const p = (parts[1] === 'b' ? 1 : 0) + i;
  const no = full + Math.floor(p / 2);
  const white = p % 2 === 0;
  return { no, white, label: white ? `${no}.` : `${no}...` };
}
