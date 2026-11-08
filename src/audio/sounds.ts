import { Chess } from 'chess.js';
import { mulberry32 } from '../util/rng';

/**
 * Move sounds. The Chess.com sound files are not used: no licence for
 * redistributing them could be found. These sounds are synthesised here from
 * scratch (filtered noise transients and short tones), are original to Chess
 * of Life, public domain like the rest of the source, and need no network:
 * they are rendered into audio buffers on first use.
 */
export type SoundKind = 'move' | 'capture' | 'check' | 'castle';

/** One sound per move, by priority: check > castle > capture > move. */
export function soundForMove(m: { san: string; flags: string; captured?: string }): SoundKind {
  if (m.san.includes('+') || m.san.includes('#')) return 'check';
  if (m.flags.includes('k') || m.flags.includes('q')) return 'castle';
  if (m.captured || m.flags.includes('c') || m.flags.includes('e')) return 'capture';
  return 'move';
}

const sameSpot = (a: string, b: string) => { const x = a.split(' '); const y = b.split(' '); return x[0] === y[0] && x[1] === y[1]; };

/**
 * The sound for a board change: the move's own sound when the new position
 * follows from the old one by one legal move, a plain move sound when the
 * change undoes one move (stepping back), and nothing for jumps or
 * unchanged positions (selecting squares, drawing arrows).
 */
export function transitionSound(prev: string, next: string): { kind: SoundKind; direction: 'forward' | 'back' } | null {
  if (!prev || !next || sameSpot(prev, next)) return null;
  try {
    const fwd = new Chess(prev).moves({ verbose: true }).find((m) => sameSpot(m.after, next));
    if (fwd) return { kind: soundForMove(fwd), direction: 'forward' };
  } catch { /* not a legal position */ }
  try {
    const back = new Chess(next).moves({ verbose: true }).find((m) => sameSpot(m.after, prev));
    if (back) return { kind: 'move', direction: 'back' };
  } catch { /* ignore */ }
  return null;
}

// ---------------- synthesis ----------------

function bandpass(x: Float32Array, f0: number, q: number, sr: number): Float32Array {
  const w = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** A wooden "tock": a filtered noise transient over a short falling thump. */
function knock(out: Float32Array, sr: number, at: number, o: { gain: number; band: number; q: number; tau: number; thump: number; thumpGain: number; seed: number }) {
  const start = Math.floor(at * sr);
  const n = Math.min(out.length - start, Math.floor(sr * 0.12));
  if (n <= 0) return;
  const rand = mulberry32(o.seed);
  const noise = new Float32Array(n);
  for (let i = 0; i < n; i++) noise[i] = (rand() * 2 - 1) * Math.exp(-i / (sr * o.tau));
  const body = bandpass(noise, o.band, o.q, sr);
  const click = bandpass(noise, o.band * 2.1, 2.5, sr);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = o.thump * (1 - 0.35 * Math.min(1, t / 0.03));
    phase += (2 * Math.PI * f) / sr;
    const thump = Math.sin(phase) * Math.exp(-t / 0.022) * o.thumpGain;
    out[start + i] += o.gain * (body[i] * 3.2 + click[i] * 0.9) + thump;
  }
}

function tone(out: Float32Array, sr: number, at: number, freq: number, gain: number, tau: number) {
  const start = Math.floor(at * sr);
  for (let i = 0; start + i < out.length; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.004) * Math.exp(-t / tau);
    out[start + i] += gain * env * (Math.sin(2 * Math.PI * freq * t) + 0.35 * Math.sin(2 * Math.PI * freq * 2.01 * t));
  }
}

const DURATION: Record<SoundKind, number> = { move: 0.12, capture: 0.17, check: 0.42, castle: 0.22 };
export const PEAK = 0.85;

export function synthesize(kind: SoundKind, sr = 44100): Float32Array {
  const out = new Float32Array(Math.floor(DURATION[kind] * sr));
  if (kind === 'move') knock(out, sr, 0, { gain: 1, band: 1500, q: 1.3, tau: 0.007, thump: 170, thumpGain: 0.55, seed: 11 });
  if (kind === 'capture') {
    knock(out, sr, 0, { gain: 1.25, band: 2300, q: 0.9, tau: 0.011, thump: 120, thumpGain: 0.8, seed: 23 });
    knock(out, sr, 0.022, { gain: 0.55, band: 1700, q: 1.1, tau: 0.006, thump: 150, thumpGain: 0.25, seed: 29 });
  }
  if (kind === 'castle') {
    knock(out, sr, 0, { gain: 0.8, band: 1350, q: 1.3, tau: 0.007, thump: 160, thumpGain: 0.45, seed: 31 });
    knock(out, sr, 0.085, { gain: 1, band: 1500, q: 1.3, tau: 0.007, thump: 170, thumpGain: 0.55, seed: 37 });
  }
  if (kind === 'check') {
    knock(out, sr, 0, { gain: 0.8, band: 1500, q: 1.3, tau: 0.007, thump: 170, thumpGain: 0.45, seed: 41 });
    tone(out, sr, 0.012, 988, 0.22, 0.1);
    tone(out, sr, 0.012, 1480, 0.12, 0.08);
  }
  // normalise, then soften the edges so there is never a click at either end
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const k = peak > 0 ? PEAK / peak : 0;
  const fadeIn = Math.floor(sr * 0.001);
  const fadeOut = Math.floor(sr * 0.01);
  for (let i = 0; i < out.length; i++) {
    let g = k;
    if (i < fadeIn) g *= i / fadeIn;
    if (i > out.length - fadeOut) g *= (out.length - i) / fadeOut;
    out[i] *= g;
  }
  return out;
}

// ---------------- playback ----------------

type AC = typeof AudioContext;
let ctx: AudioContext | null = null;
const buffers = new Map<SoundKind, AudioBuffer>();
let lastPlay = 0;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const C: AC | undefined = window.AudioContext ?? (window as unknown as { webkitAudioContext?: AC }).webkitAudioContext;
  if (!C) return null;
  if (!ctx) { try { ctx = new C({ latencyHint: 'interactive' }); } catch { return null; } }
  return ctx;
}

function buffer(c: AudioContext, kind: SoundKind): AudioBuffer {
  let b = buffers.get(kind);
  if (!b) {
    const data = synthesize(kind, c.sampleRate);
    b = c.createBuffer(1, data.length, c.sampleRate);
    b.getChannelData(0).set(data);
    buffers.set(kind, b);
  }
  return b;
}

/** Browsers only allow audio after a user gesture: create and warm up the context then. */
export function unlockAudio() {
  const c = context();
  if (!c) return;
  if (c.state === 'suspended') void c.resume().catch(() => undefined);
  for (const k of ['move', 'capture', 'check', 'castle'] as SoundKind[]) buffer(c, k);
}

export function playSound(kind: SoundKind, volume: number) {
  const c = context();
  if (!c || volume <= 0) return;
  if (c.state === 'suspended') { void c.resume().catch(() => undefined); if (c.state === 'suspended') return; }
  const now = performance.now();
  if (now - lastPlay < 25) return; // never stack two sounds on the same instant
  lastPlay = now;
  soundStats.played.push(kind);
  soundStats.total++;
  if (soundStats.played.length > 50) soundStats.played.shift();
  try {
    const src = c.createBufferSource();
    src.buffer = buffer(c, kind);
    const g = c.createGain();
    g.gain.value = Math.max(0, Math.min(1, volume));
    src.connect(g).connect(c.destination);
    src.start();
  } catch { /* audio is best effort */ }
}

/** For tests and diagnostics: the last sounds played. */
export const soundStats = { played: [] as SoundKind[], total: 0 };
if (typeof window !== 'undefined') (window as unknown as { __chessOfLifeSounds?: typeof soundStats }).__chessOfLifeSounds = soundStats;
