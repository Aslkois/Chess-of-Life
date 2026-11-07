import 'fake-indexeddb/auto';
import { Chess } from 'chess.js';
import {
  buildRepertoire, conflicts, forgotten, normaliseLine, opponentMove, practiceBack, preparedAt, recordDrill, reveal, startPractice, tryMove, weakness,
} from '../src/openings/repertoire';
import { mulberry32 } from '../src/util/rng';
import type { RepertoireLine } from '../src/db/types';

const line = (id: string, color: 'w' | 'b', moves: string[]): RepertoireLine => ({ id, name: id, color, moves: normaliseLine(moves), createdAt: 0, updatedAt: 0 });
const mv = (fen: string, san: string) => { const m = new Chess(fen).move(san); return { from: m.from, to: m.to, promotion: m.promotion }; };
const cur = (s: { fens: string[] }) => s.fens[s.fens.length - 1];

const ITALIAN = line('italian', 'w', ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'c3']);
const VS_SICILIAN = line('alapin', 'w', ['e4', 'c5', 'c3', 'Nf6', 'e5']);
const NAJDORF = line('najdorf', 'b', ['e4', 'c5', 'Nf3', 'd6', 'd4', 'cxd4', 'Nxd4', 'Nf6', 'Nc3', 'a6']);

describe('repertoire', () => {
  it('normalises and validates lines', () => {
    expect(normaliseLine(['e2e4', 'e7e5', 'Nf3'])).toEqual(['e4', 'e5', 'Nf3']);
    expect(() => normaliseLine(['e4', 'e4'])).toThrow(/1...e4 is not legal/);
  });

  it('merges lines into one tree per colour', () => {
    const idx = buildRepertoire([ITALIAN, VS_SICILIAN, NAJDORF], 'w');
    expect(idx.lines.map((l) => l.id)).toEqual(['italian', 'alapin']);
    const start = new Chess().fen();
    expect(preparedAt(idx, start).map((m) => [m.san, m.lineIds])).toEqual([['e4', ['italian', 'alapin']]]);
    const afterE4 = new Chess(); afterE4.move('e4');
    expect(preparedAt(idx, afterE4.fen()).map((m) => m.san).sort()).toEqual(['c5', 'e5']);
    expect(conflicts(idx)).toEqual([]);
    const both = buildRepertoire([ITALIAN, line('x', 'w', ['d4'])], 'w');
    expect(conflicts(both)[0].moves.sort()).toEqual(['d4', 'e4']);
  });
});

describe('practice against the training opponent', () => {
  it('accepts the prepared move, rejects others without playing them, and allows unlimited retries', () => {
    const idx = buildRepertoire([ITALIAN], 'w');
    let s = startPractice(idx);
    expect(s.status).toBe('mine');
    for (let i = 0; i < 12; i++) {
      const r = tryMove(s, idx, mv(cur(s), 'd4'));
      expect(r.correct).toBe(false);
      expect(r.expected.map((e) => e.san)).toEqual(['e4']);
      s = r.state;
      expect(s.fens).toHaveLength(1); // the wrong move was not played
    }
    expect(s.triesHere).toBe(12);
    const ok = tryMove(s, idx, mv(cur(s), 'e4'));
    expect(ok.correct).toBe(true);
    expect(ok.firstTry).toBe(false);
    expect(ok.state.missed).toBe(1);
    expect(ok.state.status).toBe('theirs');
  });

  it('plays the line to its end, with the opponent choosing among prepared replies', () => {
    const idx = buildRepertoire([ITALIAN, VS_SICILIAN], 'w');
    const rand = mulberry32(7);
    const seen = new Set<string>();
    for (let game = 0; game < 12; game++) {
      let s = startPractice(idx);
      while (s.status === 'mine' || s.status === 'theirs') {
        if (s.status === 'theirs') { s = opponentMove(s, idx, rand); continue; }
        const exp = preparedAt(idx, cur(s))[0];
        s = tryMove(s, idx, { from: exp.uci.slice(0, 2), to: exp.uci.slice(2, 4) }).state;
      }
      expect(s.status).toBe('complete');
      expect(s.missed).toBe(0);
      seen.add(s.sans[1]);
    }
    expect([...seen].sort()).toEqual(['c5', 'e5']); // both prepared replies get practised
  });

  it('can deviate into catalogued moves the repertoire does not cover', () => {
    const idx = buildRepertoire([NAJDORF], 'b');
    let uncovered = 0;
    for (let seed = 1; seed < 40; seed++) {
      const rand = mulberry32(seed);
      let s = startPractice(idx);
      expect(s.status).toBe('theirs');
      s = opponentMove(s, idx, rand, { deviate: true });
      if (s.status === 'uncovered') {
        uncovered++;
        expect(s.deviation!.san).not.toBe('e4');
      } else expect(s.sans[0]).toBe('e4');
    }
    expect(uncovered).toBeGreaterThan(0);
  });

  it('reveals the move on request (counted as not first-try) and steps back', () => {
    const idx = buildRepertoire([ITALIAN], 'w');
    let s = startPractice(idx);
    const r = reveal(s, idx);
    expect(r.expected[0].san).toBe('e4');
    s = tryMove(r.state, idx, mv(cur(s), 'e4')).state;
    expect([s.firstTry, s.missed]).toEqual([0, 1]);
    s = opponentMove(s, idx, () => 0);
    expect(s.status).toBe('mine');
    s = practiceBack(s, idx);
    expect(s.fens).toHaveLength(1);
    expect(s.status).toBe('mine');
  });
});

describe('forgotten moves', () => {
  it('tracks misses and lets a streak of correct answers wear them off', () => {
    const fen = new Chess().fen();
    let r = recordDrill(undefined, 'w', fen, ['e2e4'], false, ['d2d4'], 1);
    r = recordDrill(r, 'w', fen, ['e2e4'], false, ['g1f3'], 2);
    expect([r.attempts, r.misses, r.streak, r.wrong]).toEqual([2, 2, 0, ['g1f3', 'd2d4']]);
    const w1 = weakness(r);
    r = recordDrill(r, 'w', fen, ['e2e4'], true, [], 3);
    expect(weakness(r)).toBeLessThan(w1);
    expect(forgotten([r])).toHaveLength(1);
    for (let i = 0; i < 4; i++) r = recordDrill(r, 'w', fen, ['e2e4'], true, [], 4 + i);
    expect(forgotten([r])).toHaveLength(0);
  });
});
