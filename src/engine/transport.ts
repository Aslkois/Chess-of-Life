/** Minimal line-based channel to a UCI engine. */
export interface UciTransport {
  send(cmd: string): void;
  onLine(cb: (line: string) => void): void;
  onError(cb: (err: unknown) => void): void;
  terminate(): void;
}

export const ENGINE_URL = `${import.meta.env?.BASE_URL ?? '/'}engine/stockfish.js`;

/** Stockfish (WASM) running in a dedicated Web Worker. */
export function createWorkerTransport(url: string = ENGINE_URL): UciTransport {
  const worker = new Worker(url);
  let lineCb: (l: string) => void = () => {};
  let errCb: (e: unknown) => void = () => {};
  worker.onmessage = (e: MessageEvent) => {
    const data = typeof e.data === 'string' ? e.data : String(e.data);
    for (const l of data.split('\n')) if (l.trim()) lineCb(l.trim());
  };
  worker.onerror = (e) => errCb(e);
  worker.onmessageerror = (e) => errCb(e);
  return {
    send: (c) => worker.postMessage(c),
    onLine: (cb) => { lineCb = cb; },
    onError: (cb) => { errCb = cb; },
    terminate: () => worker.terminate(),
  };
}
