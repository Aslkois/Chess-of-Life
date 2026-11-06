import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { UciTransport } from '../src/engine/transport';

const require = createRequire(import.meta.url);

/** Real Stockfish (same WASM build as the app) driven over stdio, for integration tests. */
export function createNodeTransport(): UciTransport {
  const path = require.resolve('stockfish/src/stockfish-17.1-lite-single-03e3232.js');
  const proc = spawn(process.execPath, [path], { stdio: ['pipe', 'pipe', 'pipe'] });
  let lineCb: (l: string) => void = () => {};
  let errCb: (e: unknown) => void = () => {};
  let buf = '';
  proc.stdout.on('data', (d: Buffer) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (l) lineCb(l);
    }
  });
  proc.on('error', (e) => errCb(e));
  proc.on('exit', (code) => { if (code) errCb(new Error(`exit ${code}`)); });
  return {
    send: (c) => { if (!proc.killed) proc.stdin.write(c + '\n'); },
    onLine: (cb) => { lineCb = cb; },
    onError: (cb) => { errCb = cb; },
    terminate: () => { proc.kill(); },
  };
}
