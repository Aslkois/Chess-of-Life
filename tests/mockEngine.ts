import type { UciTransport } from '../src/engine/transport';

/**
 * Scripted UCI engine for controller tests. Each "go" produces info lines on a
 * timer and a bestmove; "stop" ends the current search immediately after
 * emitting one stale info line (as real engines can).
 */
export function createMockTransport(opts: { delayMs?: number; failOnGo?: number } = {}) {
  let cb: (l: string) => void = () => {};
  let errCb: (e: unknown) => void = () => {};
  let fen = '';
  let multipv = 1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let goCount = 0;
  const log: string[] = [];
  const finish = (tag: string) => {
    timer = null;
    cb(`bestmove ${tag}`);
  };
  const t: UciTransport & { log: string[]; crash: () => void } = {
    log,
    send(cmd) {
      log.push(cmd);
      if (cmd === 'uci') setTimeout(() => { cb('id name MockFish'); cb('uciok'); }, 1);
      else if (cmd === 'isready') setTimeout(() => cb('readyok'), 1);
      else if (cmd.startsWith('setoption name MultiPV')) multipv = parseInt(cmd.split(' ').pop()!, 10);
      else if (cmd.startsWith('position fen ')) fen = cmd.slice(13);
      else if (cmd.startsWith('go')) {
        goCount++;
        if (opts.failOnGo && goCount === opts.failOnGo) { setTimeout(() => errCb(new Error('crash')), 2); return; }
        const depth = parseInt(cmd.match(/depth (\d+)/)?.[1] ?? '10', 10);
        const tag = fen.includes(' w ') ? 'e2e4' : 'e7e5';
        const myFen = fen;
        timer = setTimeout(() => {
          for (let d = 1; d <= depth; d++) for (let k = 1; k <= multipv; k++) cb(`info depth ${d} multipv ${k} score cp ${10 * k} nodes ${d * 100} pv ${tag} ${myFen.length % 2 ? 'a7a6' : 'h7h6'}`);
          finish(tag);
        }, opts.delayMs ?? 20);
      } else if (cmd === 'stop') {
        if (timer) {
          clearTimeout(timer);
          cb('info depth 3 multipv 1 score cp 999 pv h2h4 h7h5'); // stale output
          finish('h2h4');
        }
      }
    },
    onLine: (f) => { cb = f; },
    onError: (f) => { errCb = f; },
    terminate: () => { if (timer) clearTimeout(timer); },
    crash: () => errCb(new Error('boom')),
  };
  return t;
}
