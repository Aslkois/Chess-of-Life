import { formatScore, normalizeScore, povCp, toCp, winPercent } from '../src/engine/score';
import { parseInfo, parseBestmove } from '../src/engine/uci';

describe('score normalisation', () => {
  it('converts side-to-move scores to White POV', () => {
    expect(normalizeScore({ cp: 50 }, 'w')).toEqual({ cp: 50 });
    expect(normalizeScore({ cp: 50 }, 'b')).toEqual({ cp: -50 });
    expect(normalizeScore({ mate: 3 }, 'b')).toEqual({ mate: -3 });
    expect(normalizeScore({ mate: -2 }, 'b')).toEqual({ mate: 2 });
    expect(normalizeScore({ mate: 0 }, 'w')).toEqual({ mated: 'w' });
  });

  it('orders mates above any centipawn score and faster mates higher', () => {
    expect(toCp({ mate: 1 })).toBeGreaterThan(toCp({ mate: 5 }));
    expect(toCp({ mate: 5 })).toBeGreaterThan(toCp({ cp: 5000 }));
    expect(toCp({ mate: -1 })).toBeLessThan(toCp({ mate: -5 }));
    expect(toCp({ mated: 'b' })).toBeGreaterThan(toCp({ mate: 1 }) - 1);
    expect(povCp({ mate: 2 }, 'b')).toBeLessThan(0);
  });

  it('maps scores to winning chances', () => {
    expect(winPercent({ cp: 0 })).toBeCloseTo(50, 5);
    expect(winPercent({ cp: 300 })).toBeGreaterThan(75);
    expect(winPercent({ cp: -300 })).toBeLessThan(25);
    expect(winPercent({ mate: 4 })).toBe(100);
    expect(winPercent({ mate: -4 })).toBe(0);
    expect(winPercent({ mated: 'w' })).toBe(0);
  });

  it('formats scores', () => {
    expect(formatScore({ cp: 123 })).toBe('+1.23');
    expect(formatScore({ mate: -3 })).toBe('-M3');
    expect(formatScore({ mated: 'b' })).toBe('1-0#');
  });

  it('parses UCI info lines from the side to move', () => {
    const l = parseInfo('info depth 12 seldepth 18 multipv 2 score cp 35 nodes 100 nps 1000 time 5 pv e2e4 e7e5', 'b');
    expect(l).toMatchObject({ depth: 12, multipv: 2, score: { cp: -35 }, pv: ['e2e4', 'e7e5'] });
    expect(parseInfo('info depth 5 currmove e2e4 currmovenumber 1', 'w')).toBeNull();
    expect(parseInfo('info depth 9 score cp 20 lowerbound pv e2e4', 'w')?.bound).toBe('lower');
    expect(parseBestmove('bestmove (none)')).toEqual({ bestmove: null, ponder: undefined });
    expect(parseBestmove('bestmove e2e4 ponder e7e5')).toEqual({ bestmove: 'e2e4', ponder: 'e7e5' });
  });
});
