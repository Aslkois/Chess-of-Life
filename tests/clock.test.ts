import { createClock, flaggedSide, formatClock, pressClock, remainingMs, startClock } from '../src/chess/clock';

describe('chess clock', () => {
  it('deducts elapsed time and adds the increment', () => {
    let c = startClock(createClock({ initial: 60, increment: 2 }), 'w', 0);
    expect(remainingMs(c, 'w', 10000)).toBe(50000);
    const r = pressClock(c, 'w', 10000);
    c = r.clock;
    expect(r.flagged).toBe(false);
    expect(r.spentMs).toBe(10000);
    expect(c.remaining.w).toBe(52000);
    expect(c.running).toBe('b');
    expect(remainingMs(c, 'b', 15000)).toBe(55000);
  });

  it('flags a side that runs out of time and gives no increment', () => {
    const c = startClock(createClock({ initial: 5, increment: 3 }), 'w', 0);
    expect(flaggedSide(c, 4999)).toBe(null);
    expect(flaggedSide(c, 5000)).toBe('w');
    const r = pressClock(c, 'w', 6000);
    expect(r.flagged).toBe(true);
    expect(r.clock.remaining.w).toBe(0);
  });

  it('untimed clocks never flag', () => {
    const c = startClock(createClock({ initial: 0, increment: 0 }), 'w', 0);
    expect(remainingMs(c, 'w', 1e9)).toBe(Infinity);
    expect(flaggedSide(c, 1e9)).toBe(null);
  });

  it('formats times', () => {
    expect(formatClock(65000)).toBe('1:05');
    expect(formatClock(9500)).toBe('0:09.5');
    expect(formatClock(3723000)).toBe('1:02:03');
  });
});
