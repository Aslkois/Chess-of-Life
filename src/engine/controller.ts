import { Chess } from 'chess.js';
import { positionKey } from '../chess/positionKey';
import { DRAW_SCORE, matedScore, type Score } from './score';
import type { UciTransport } from './transport';
import { parseBestmove, parseInfo, type PvLine } from './uci';

export type Priority = 0 | 1 | 2; // 0 = background, 1 = normal, 2 = interactive

export interface AnalysisRequest {
  fen: string;
  depth?: number;
  movetime?: number;
  nodes?: number;
  multipv?: number;
  /** restrict search to these UCI moves */
  searchmoves?: string[];
  priority?: Priority;
  signal?: AbortSignal;
  onProgress?: (r: AnalysisResult) => void;
  /** do not read from cache */
  fresh?: boolean;
}

export interface AnalysisResult {
  fen: string;
  key: string;
  depth: number;
  lines: PvLine[];
  bestmove: string | null;
  nodes?: number;
  time?: number;
  fromCache?: boolean;
  /** terminal position: no legal moves */
  terminal?: 'checkmate' | 'stalemate';
}

export interface AnalysisCache {
  get(key: string): Promise<AnalysisResult | undefined> | AnalysisResult | undefined;
  set(key: string, value: AnalysisResult): Promise<void> | void;
}

export class AbortedError extends Error {
  constructor(msg = 'Analysis cancelled') {
    super(msg);
    this.name = 'AbortedError';
  }
}

interface Job {
  id: number;
  req: AnalysisRequest;
  priority: Priority;
  multipv: number;
  side: 'w' | 'b';
  lines: Map<number, PvLine>;
  depth: number;
  nodes?: number;
  time?: number;
  resolve: (r: AnalysisResult) => void;
  reject: (e: unknown) => void;
  attempts: number;
  state: 'queued' | 'running' | 'stopping' | 'done';
  /** why we are stopping: cancel => reject, preempt => requeue */
  stopReason?: 'cancel' | 'preempt';
}

export interface EngineStatus {
  ready: boolean;
  busy: boolean;
  queued: number;
  restarts: number;
  error?: string;
  name?: string;
}

export interface ControllerOptions {
  hashMb?: number;
  /** ms without any engine output during a search before the engine is considered hung */
  watchdogMs?: number;
  memoryCacheSize?: number;
  persistentCache?: AnalysisCache;
}

export function cacheKey(fen: string, multipv: number, searchmoves?: string[]) {
  return `${positionKey(fen)}|${multipv}${searchmoves?.length ? '|' + [...searchmoves].sort().join(',') : ''}`;
}

/**
 * UCI engine controller. Owns one engine process (Web Worker), serialises
 * searches through a priority queue, tags each search with an id, rejects
 * stale output after cancellation, caches results per position and restarts
 * the engine on failure.
 */
export class EngineController {
  private transport: UciTransport | null = null;
  private readyPromise: Promise<void> | null = null;
  private queue: Job[] = [];
  private active: Job | null = null;
  private nextId = 1;
  private currentMultiPv = -1;
  private lastOutput = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private memCache = new Map<string, AnalysisResult>();
  private listeners = new Set<(s: EngineStatus) => void>();
  private pendingReady: (() => void) | null = null;
  private pendingUciOk: (() => void) | null = null;
  status: EngineStatus = { ready: false, busy: false, queued: 0, restarts: 0 };
  private opts: Required<Omit<ControllerOptions, 'persistentCache'>> & { persistentCache?: AnalysisCache };

  constructor(private factory: () => UciTransport, opts: ControllerOptions = {}) {
    this.opts = { hashMb: 32, watchdogMs: 20000, memoryCacheSize: 4000, ...opts };
  }

  subscribe(cb: (s: EngineStatus) => void): () => void {
    this.listeners.add(cb);
    cb(this.status);
    return () => this.listeners.delete(cb);
  }

  private emit(patch: Partial<EngineStatus>) {
    this.status = { ...this.status, ...patch, queued: this.queue.length, busy: !!this.active };
    for (const l of this.listeners) l(this.status);
  }

  init(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolve, reject) => {
      let t: UciTransport;
      try {
        t = this.factory();
      } catch (e) {
        this.emit({ error: `Engine failed to start: ${String(e)}` });
        this.readyPromise = null;
        reject(e);
        return;
      }
      this.transport = t;
      this.currentMultiPv = -1;
      t.onLine((l) => this.onLine(l));
      t.onError((e) => this.onFailure(e));
      const timer = setTimeout(() => {
        this.emit({ error: 'Engine did not respond to initialisation.' });
        reject(new Error('Engine init timeout'));
        this.readyPromise = null;
      }, 30000);
      this.pendingUciOk = () => {
        t.send(`setoption name Hash value ${this.opts.hashMb}`);
        t.send('isready');
        this.pendingReady = () => {
          clearTimeout(timer);
          this.emit({ ready: true, error: undefined });
          resolve();
          this.pump();
        };
      };
      t.send('uci');
    });
    if (!this.watchdog) this.watchdog = setInterval(() => this.checkWatchdog(), 2000);
    return this.readyPromise;
  }

  private onLine(line: string) {
    this.lastOutput = Date.now();
    if (line.startsWith('id name')) { this.emit({ name: line.slice(8) }); return; }
    if (line === 'uciok') { const f = this.pendingUciOk; this.pendingUciOk = null; f?.(); return; }
    if (line === 'readyok') { const f = this.pendingReady; this.pendingReady = null; f?.(); return; }
    const job = this.active;
    if (!job) return; // stale output with no active search
    if (line.startsWith('info ')) {
      if (job.state !== 'running') return; // stale: search is being stopped
      const info = parseInfo(line, job.side);
      if (!info || info.bound) return;
      if (info.multipv === 1 && info.depth > job.depth) {
        // new iteration: drop lines from shallower depth
        for (const [k, v] of job.lines) if (v.depth < info.depth - 1) job.lines.delete(k);
      }
      job.lines.set(info.multipv, { multipv: info.multipv, depth: info.depth, score: info.score, pv: info.pv });
      job.depth = Math.max(job.depth, info.depth);
      job.nodes = info.nodes ?? job.nodes;
      job.time = info.time ?? job.time;
      if (info.multipv === job.multipv || job.lines.size >= job.multipv) {
        try { job.req.onProgress?.(this.snapshot(job, null)); } catch { /* listener errors are ignored */ }
      }
      return;
    }
    const bm = parseBestmove(line);
    if (bm) {
      this.active = null;
      if (job.state === 'stopping') {
        if (job.stopReason === 'preempt') {
          job.state = 'queued';
          this.enqueue(job);
        } else {
          job.state = 'done';
          job.reject(new AbortedError());
        }
      } else {
        job.state = 'done';
        const result = this.snapshot(job, bm.bestmove);
        this.store(job, result);
        job.resolve(result);
      }
      this.emit({});
      this.pump();
    }
  }

  private snapshot(job: Job, bestmove: string | null): AnalysisResult {
    const lines = [...job.lines.values()].sort((a, b) => a.multipv - b.multipv);
    return {
      fen: job.req.fen,
      key: cacheKey(job.req.fen, job.multipv, job.req.searchmoves),
      depth: lines.length ? Math.min(...lines.map((l) => l.depth)) : job.depth,
      lines,
      bestmove: bestmove ?? lines[0]?.pv[0] ?? null,
      nodes: job.nodes,
      time: job.time,
    };
  }

  private store(job: Job, r: AnalysisResult) {
    if (job.req.movetime || job.req.nodes) return; // depth is what makes cached results comparable
    if (!r.lines.length) return;
    const prev = this.memCache.get(r.key);
    if (prev && prev.depth > r.depth) return;
    this.memCache.set(r.key, r);
    if (this.memCache.size > this.opts.memoryCacheSize) {
      const first = this.memCache.keys().next().value;
      if (first) this.memCache.delete(first);
    }
    void this.opts.persistentCache?.set(r.key, r);
  }

  private async lookup(req: AnalysisRequest, multipv: number): Promise<AnalysisResult | undefined> {
    if (req.fresh || req.movetime || req.nodes) return undefined;
    const key = cacheKey(req.fen, multipv, req.searchmoves);
    const want = req.depth ?? 0;
    const mem = this.memCache.get(key);
    if (mem && mem.depth >= want) return { ...mem, fen: req.fen, fromCache: true };
    // a higher multipv result also answers a lower multipv question
    for (const mpv of [multipv + 1, multipv + 2, 5]) {
      const alt = this.memCache.get(cacheKey(req.fen, mpv, req.searchmoves));
      if (alt && alt.depth >= want && alt.lines.length >= multipv) return { ...alt, fen: req.fen, lines: alt.lines.slice(0, multipv), fromCache: true };
    }
    if (this.opts.persistentCache) {
      try {
        const p = await this.opts.persistentCache.get(key);
        if (p && p.depth >= want) {
          this.memCache.set(key, p);
          return { ...p, fen: req.fen, fromCache: true };
        }
      } catch { /* cache failures never block analysis */ }
    }
    return undefined;
  }

  /** Analyse a position. Resolves with the final result, rejects with AbortedError when cancelled. */
  async analyze(req: AnalysisRequest): Promise<AnalysisResult> {
    const multipv = Math.max(1, req.multipv ?? 1);
    let side: 'w' | 'b';
    let chess: Chess;
    try {
      chess = new Chess(req.fen);
      side = chess.turn();
    } catch {
      throw new Error(`Invalid FEN: ${req.fen}`);
    }
    if (req.signal?.aborted) throw new AbortedError();
    // terminal positions never reach the engine
    if (chess.moves().length === 0) {
      const mate = chess.isCheckmate();
      return {
        fen: req.fen,
        key: cacheKey(req.fen, multipv),
        depth: 999,
        bestmove: null,
        terminal: mate ? 'checkmate' : 'stalemate',
        lines: [{ multipv: 1, depth: 999, score: mate ? matedScore(side) : (DRAW_SCORE as Score), pv: [] }],
      };
    }
    const cached = await this.lookup(req, multipv);
    if (cached) return cached;
    if (req.signal?.aborted) throw new AbortedError();
    await this.init();
    return new Promise<AnalysisResult>((resolve, reject) => {
      const job: Job = {
        id: this.nextId++,
        req,
        priority: req.priority ?? 1,
        multipv,
        side,
        lines: new Map(),
        depth: 0,
        resolve,
        reject,
        attempts: 0,
        state: 'queued',
      };
      req.signal?.addEventListener('abort', () => this.cancelJob(job), { once: true });
      this.enqueue(job);
      // preempt a lower-priority running search
      const a = this.active;
      if (a && a.state === 'running' && a.priority < job.priority) {
        a.state = 'stopping';
        a.stopReason = 'preempt';
        this.transport?.send('stop');
      }
      this.pump();
    });
  }

  private enqueue(job: Job) {
    this.queue.push(job);
    // stable sort by priority desc, then id asc
    this.queue.sort((a, b) => b.priority - a.priority || a.id - b.id);
    this.emit({});
  }

  private cancelJob(job: Job) {
    if (job.state === 'queued') {
      this.queue = this.queue.filter((j) => j !== job);
      job.state = 'done';
      job.reject(new AbortedError());
      this.emit({});
    } else if (job.state === 'running') {
      job.state = 'stopping';
      job.stopReason = 'cancel';
      this.transport?.send('stop');
    } else if (job.state === 'stopping') {
      job.stopReason = 'cancel';
    }
  }

  /** Cancel every queued and running search. */
  cancelAll() {
    for (const j of [...this.queue]) this.cancelJob(j);
    if (this.active) this.cancelJob(this.active);
  }

  private pump() {
    if (this.active || !this.status.ready || !this.transport) return;
    const job = this.queue.shift();
    if (!job) { this.emit({}); return; }
    this.active = job;
    job.state = 'running';
    job.lines = new Map();
    job.depth = 0;
    const t = this.transport;
    if (this.currentMultiPv !== job.multipv) {
      t.send(`setoption name MultiPV value ${job.multipv}`);
      this.currentMultiPv = job.multipv;
    }
    t.send(`position fen ${job.req.fen}`);
    let go = 'go';
    if (job.req.depth) go += ` depth ${job.req.depth}`;
    if (job.req.movetime) go += ` movetime ${job.req.movetime}`;
    if (job.req.nodes) go += ` nodes ${job.req.nodes}`;
    if (!job.req.depth && !job.req.movetime && !job.req.nodes) go += ' depth 14';
    if (job.req.searchmoves?.length) go += ` searchmoves ${job.req.searchmoves.join(' ')}`;
    this.lastOutput = Date.now();
    t.send(go);
    this.emit({});
  }

  private checkWatchdog() {
    if (this.active && Date.now() - this.lastOutput > this.opts.watchdogMs) {
      this.onFailure(new Error('Engine stopped responding'));
    }
  }

  private onFailure(err: unknown) {
    const job = this.active;
    this.active = null;
    this.emit({ ready: false, error: `Engine error: ${err instanceof Error ? err.message : String(err)} – restarting.`, restarts: this.status.restarts + 1 });
    try { this.transport?.terminate(); } catch { /* ignore */ }
    this.transport = null;
    this.readyPromise = null;
    if (job) {
      if (job.state === 'stopping' && job.stopReason === 'cancel') {
        job.state = 'done';
        job.reject(new AbortedError());
      } else if (job.attempts < 2) {
        job.attempts++;
        job.state = 'queued';
        this.queue.unshift(job);
      } else {
        job.state = 'done';
        job.reject(new Error('Engine failed repeatedly on this position.'));
      }
    }
    if (this.status.restarts > 8) {
      for (const j of this.queue) j.reject(new Error('Engine unavailable'));
      this.queue = [];
      this.emit({ error: 'The engine keeps failing. Reload the page to try again.' });
      return;
    }
    this.init().catch(() => { /* reported via status */ });
  }

  /** Terminate and start a fresh engine (e.g. after the user changes settings). */
  async restart() {
    this.cancelAll();
    try { this.transport?.terminate(); } catch { /* ignore */ }
    this.transport = null;
    this.readyPromise = null;
    this.active = null;
    this.emit({ ready: false });
    await this.init();
  }

  dispose() {
    this.cancelAll();
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    try { this.transport?.send('quit'); this.transport?.terminate(); } catch { /* ignore */ }
    this.transport = null;
    this.readyPromise = null;
  }

  clearMemoryCache() {
    this.memCache.clear();
  }
}
