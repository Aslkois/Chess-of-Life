import { moveLabel, replayReducer, startReplay, tickMs } from '../src/coach/replay';

describe('Show Me playback', () => {
  it('plays automatically and stops at the end, leaving the line on the board', () => {
    let s = startReplay(3);
    expect(s).toMatchObject({ step: 0, playing: true, speed: 1 });
    s = replayReducer(s, { t: 'tick' });
    s = replayReducer(s, { t: 'tick' });
    s = replayReducer(s, { t: 'tick' });
    expect(s).toMatchObject({ step: 3, playing: false });
    expect(replayReducer(s, { t: 'tick' })).toBe(s); // nothing more happens
  });

  it('pauses when the user navigates by hand, during and after playback', () => {
    let s = startReplay(5);
    s = replayReducer(s, { t: 'tick' });
    s = replayReducer(s, { t: 'next' });
    expect(s).toMatchObject({ step: 2, playing: false });
    s = replayReducer(s, { t: 'prev' });
    s = replayReducer(s, { t: 'prev' });
    s = replayReducer(s, { t: 'prev' });
    expect(s.step).toBe(0); // clamped
    s = replayReducer(s, { t: 'last' });
    expect(s).toMatchObject({ step: 5, playing: false });
    s = replayReducer(s, { t: 'goto', step: 2 });
    expect(s.step).toBe(2);
    s = replayReducer(s, { t: 'goto', step: 99 });
    expect(s.step).toBe(5);
    s = replayReducer(s, { t: 'first' });
    expect(s.step).toBe(0);
  });

  it('toggles play and pause, restarts from the end, and replays', () => {
    let s = replayReducer(startReplay(2, 1, false), { t: 'toggle' });
    expect(s.playing).toBe(true);
    s = replayReducer(s, { t: 'toggle' });
    expect(s.playing).toBe(false);
    s = replayReducer(s, { t: 'last' });
    s = replayReducer(s, { t: 'toggle' }); // at the end: play again from the start
    expect(s).toMatchObject({ step: 0, playing: true });
    s = replayReducer(replayReducer(s, { t: 'next' }), { t: 'replay' });
    expect(s).toMatchObject({ step: 0, playing: true });
  });

  it('changes speed without stopping, and scales the step delay', () => {
    let s = replayReducer(startReplay(4), { t: 'tick' });
    expect(tickMs(s)).toBe(1100);
    s = replayReducer(s, { t: 'speed', speed: 2 });
    expect(s.playing).toBe(true);
    expect(tickMs(s)).toBe(550);
    expect(tickMs(replayReducer(s, { t: 'speed', speed: 0.5 }))).toBe(2200);
  });

  it('numbers moves from the position the line starts in', () => {
    const blackToMove = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1';
    expect(moveLabel(blackToMove, 0)).toMatchObject({ no: 1, white: false, label: '1...' });
    expect(moveLabel(blackToMove, 1)).toMatchObject({ no: 2, white: true, label: '2.' });
    expect(moveLabel('8/8/8/8/8/8/8/K6k w - - 0 23', 0).label).toBe('23.');
  });
});
