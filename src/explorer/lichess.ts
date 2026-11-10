import { positionKey } from '../chess/positionKey';
import type { ExGame, ExMove, ExResult, LichessFilter, MastersFilter, PlayerFilter } from './types';

/**
 * Client for the documented Lichess Opening Explorer
 * (https://lichess.org/api#tag/Opening-Explorer, host explorer.lichess.org).
 * The endpoints require an OAuth2 token: either a free personal access token
 * or "Log in with Lichess" (authorization code flow with PKCE, which Lichess
 * supports for unregistered public clients). The token stays in this browser
 * (localStorage) and is never included in backups.
 *
 * Lichess asks clients to make one request at a time and to wait a minute
 * after a 429; this client queues requests, honours the cooldown and caches
 * responses so positions already seen also work offline.
 */
export const EXPLORER_HOST = 'https://explorer.lichess.org';
export const LICHESS_HOST = 'https://lichess.org';
const TOKEN_KEY = 'col.lichess.token';
const USER_KEY = 'col.lichess.user';
const CACHE_KEY = 'col.lichess.cache';
const CACHE_MAX = 400;

export class ExplorerError extends Error {
  constructor(public kind: 'auth' | 'rate' | 'offline' | 'http' | 'format', message: string, public retryAt?: number) { super(message); }
}

// ---------------- token ----------------
const ls = (): Storage | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };
export function getToken(): string | null { return ls()?.getItem(TOKEN_KEY) ?? null; }
export function getLichessUser(): string | null { return ls()?.getItem(USER_KEY) ?? null; }
export function setToken(token: string | null, user?: string | null) {
  const s = ls(); if (!s) return;
  if (token) s.setItem(TOKEN_KEY, token); else s.removeItem(TOKEN_KEY);
  if (user) s.setItem(USER_KEY, user); else if (!token) s.removeItem(USER_KEY);
  listeners.forEach((l) => l());
}
const listeners = new Set<() => void>();
export function onTokenChange(l: () => void) { listeners.add(l); return () => listeners.delete(l); }
export const isValidToken = (t: string) => /^[A-Za-z0-9_]{8,512}$/.test(t);

// ---------------- transport (one request at a time, 429 cooldown) ----------------
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: Fetch = (u, i) => fetch(u, i);
export function setFetch(f: Fetch) { fetchImpl = f; }
let chain: Promise<unknown> = Promise.resolve();
let cooldownUntil = 0;
export function resetClient() { chain = Promise.resolve(); cooldownUntil = 0; memCache.clear(); }
export const now = () => Date.now();

function queued<T>(job: () => Promise<T>): Promise<T> {
  const run = chain.catch(() => undefined).then(job);
  chain = run.catch(() => undefined);
  return run;
}

async function request(url: string, accept = 'application/json'): Promise<string> {
  return queued(async () => {
    if (now() < cooldownUntil) throw new ExplorerError('rate', 'Lichess asked us to slow down. Trying again shortly.', cooldownUntil);
    const token = getToken();
    if (!token && url.startsWith(EXPLORER_HOST)) throw new ExplorerError('auth', 'Connect a Lichess account to use this database.');
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { Accept: accept, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
    } catch {
      throw new ExplorerError('offline', 'Lichess could not be reached. Positions you have already looked at stay available offline.');
    }
    if (res.status === 401 || res.status === 403) throw new ExplorerError('auth', 'Lichess did not accept the token. Connect your account again.');
    if (res.status === 429) { cooldownUntil = now() + 60_000; throw new ExplorerError('rate', 'Lichess rate limit reached. Waiting one minute before the next request.', cooldownUntil); }
    if (!res.ok) throw new ExplorerError('http', `Lichess answered ${res.status}.`);
    return res.text();
  });
}

// ---------------- cache ----------------
const memCache = new Map<string, { at: number; data: ExResult }>();
function cacheGet(key: string, ttl: number): ExResult | null {
  const m = memCache.get(key);
  if (m && now() - m.at < ttl) return { ...m.data, fromCache: true };
  try {
    const all = JSON.parse(ls()?.getItem(CACHE_KEY) ?? '{}') as Record<string, { at: number; data: ExResult }>;
    const e = all[key];
    if (e && now() - e.at < ttl) { memCache.set(key, e); return { ...e.data, fromCache: true }; }
  } catch { /* ignore */ }
  return null;
}
/** Anything cached, however old (used when Lichess is unreachable). */
function cacheStale(key: string): ExResult | null {
  const m = memCache.get(key);
  if (m) return { ...m.data, fromCache: true };
  try { const e = (JSON.parse(ls()?.getItem(CACHE_KEY) ?? '{}') as Record<string, { at: number; data: ExResult }>)[key]; return e ? { ...e.data, fromCache: true } : null; } catch { return null; }
}
function cachePut(key: string, data: ExResult) {
  const e = { at: now(), data };
  memCache.set(key, e);
  try {
    const s = ls(); if (!s) return;
    const all = JSON.parse(s.getItem(CACHE_KEY) ?? '{}') as Record<string, { at: number; data: ExResult }>;
    all[key] = e;
    const keys = Object.keys(all);
    if (keys.length > CACHE_MAX) keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - CACHE_MAX).forEach((k) => delete all[k]);
    s.setItem(CACHE_KEY, JSON.stringify(all));
  } catch { /* storage full: memory cache only */ }
}

// ---------------- normalisation ----------------
/** X-FEN for a position with the legally relevant en passant square only (transpositions share one key). */
export function explorerFen(fen: string): string { return `${positionKey(fen)} 0 1`; }

type RawGame = { id: string; winner: 'white' | 'black' | null; white: { name: string; rating?: number }; black: { name: string; rating?: number }; year?: number; month?: string | null; speed?: string; uci?: string };
type RawMove = { uci: string; san: string; white: number; draws: number; black: number; averageRating?: number; averageOpponentRating?: number; performance?: number; opening?: { eco: string; name: string } | null };
type Raw = { white: number; draws: number; black: number; moves: RawMove[]; topGames?: RawGame[]; recentGames?: RawGame[]; opening?: { eco: string; name: string } | null; queuePosition?: number };

export function normalise(db: 'masters' | 'lichess' | 'player', raw: Raw, requestedMoves: number): ExResult {
  if (!raw || typeof raw.white !== 'number' || !Array.isArray(raw.moves)) throw new ExplorerError('format', 'Unexpected answer from Lichess.');
  const game = (g: RawGame): ExGame => ({ id: g.id, source: db === 'masters' ? 'masters' : 'lichess', white: { name: g.white?.name ?? '?', rating: g.white?.rating }, black: { name: g.black?.name ?? '?', rating: g.black?.rating }, winner: g.winner ?? null, year: g.year, month: g.month ?? null, uci: g.uci, speed: g.speed });
  const moves: ExMove[] = raw.moves.map((m) => ({ uci: m.uci, san: m.san, white: m.white, draws: m.draws, black: m.black, averageRating: m.averageRating ?? m.averageOpponentRating, performance: m.performance, opening: m.opening ?? null }));
  return {
    db, white: raw.white, draws: raw.draws, black: raw.black, moves,
    topGames: (raw.topGames ?? []).map(game), recentGames: (raw.recentGames ?? []).map(game), opening: raw.opening ?? null,
    queuePosition: raw.queuePosition, fetchedAt: now(), truncated: moves.length >= requestedMoves,
  };
}

const MOVES = 30;
function qs(params: Record<string, string | number | undefined>): string {
  return Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

async function cached(key: string, ttl: number, load: () => Promise<ExResult>): Promise<ExResult> {
  const hit = cacheGet(key, ttl);
  if (hit) return hit;
  try {
    const r = await load();
    if (!(r.queuePosition && r.queuePosition > 0)) cachePut(key, r);
    return r;
  } catch (e) {
    const stale = e instanceof ExplorerError && (e.kind === 'offline' || e.kind === 'rate') ? cacheStale(key) : null;
    if (stale) return stale;
    throw e;
  }
}

export function mastersUrl(fen: string, f: MastersFilter): string {
  return `${EXPLORER_HOST}/masters?${qs({ fen: explorerFen(fen), since: f.since, until: f.until, moves: MOVES, topGames: 15 })}`;
}
export function lichessUrl(fen: string, f: LichessFilter): string {
  return `${EXPLORER_HOST}/lichess?${qs({ variant: 'standard', fen: explorerFen(fen), speeds: f.speeds.join(',') || undefined, ratings: f.ratings.join(',') || undefined, since: f.since, until: f.until, moves: MOVES, topGames: 4, recentGames: 4 })}`;
}
export function playerUrl(fen: string, f: PlayerFilter): string {
  return `${EXPLORER_HOST}/player?${qs({ player: f.name, color: f.color, variant: 'standard', fen: explorerFen(fen), speeds: f.speeds.join(',') || undefined, modes: f.modes.join(',') || undefined, since: f.since, until: f.until, moves: MOVES, recentGames: 8 })}`;
}

export async function fetchMasters(fen: string, f: MastersFilter): Promise<ExResult> {
  const url = mastersUrl(fen, f);
  return cached(url, 30 * 86400_000, async () => normalise('masters', JSON.parse(await request(url)), MOVES));
}
export async function fetchLichess(fen: string, f: LichessFilter): Promise<ExResult> {
  const url = lichessUrl(fen, f);
  return cached(url, 86400_000, async () => normalise('lichess', JSON.parse(await request(url)), MOVES));
}
/** The player endpoint streams ND-JSON while it indexes; the last line is the current state. */
export async function fetchPlayer(fen: string, f: PlayerFilter): Promise<ExResult> {
  if (!f.name.trim()) throw new ExplorerError('format', 'Enter a Lichess username.');
  const url = playerUrl(fen, f);
  return cached(url, 3600_000, async () => {
    const text = await request(url, 'application/x-ndjson');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) throw new ExplorerError('format', 'Empty answer from Lichess.');
    return normalise('player', JSON.parse(lines[lines.length - 1]), MOVES);
  });
}

/** PGN of a master game (explorer, needs the token) or of a Lichess game (public export). */
export async function fetchGamePgn(g: Pick<ExGame, 'id' | 'source'>): Promise<string> {
  const url = g.source === 'masters' ? `${EXPLORER_HOST}/masters/pgn/${encodeURIComponent(g.id)}` : `${LICHESS_HOST}/game/export/${encodeURIComponent(g.id)}?clocks=false&evals=false`;
  return request(url, 'application/x-chess-pgn');
}

// ---------------- Log in with Lichess (authorization code flow with PKCE) ----------------
export const CLIENT_ID = 'chess-of-life';
const PKCE_KEY = 'col.lichess.pkce';

function b64url(bytes: Uint8Array): string {
  let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function startLichessLogin(redirectUri: string): Promise<string> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(12)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, redirectUri }));
  return `${LICHESS_HOST}/oauth?${qs({ response_type: 'code', client_id: CLIENT_ID, redirect_uri: redirectUri, code_challenge_method: 'S256', code_challenge: challenge, state })}`;
}
/** Complete the login when Lichess redirects back with ?code=…&state=…; returns the username. */
export async function completeLichessLogin(search: string): Promise<string | null> {
  const p = new URLSearchParams(search);
  const code = p.get('code'), state = p.get('state');
  if (!code || !state) return null;
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) ?? 'null') as { verifier: string; state: string; redirectUri: string } | null;
  sessionStorage.removeItem(PKCE_KEY);
  if (!saved || saved.state !== state) throw new ExplorerError('auth', 'The Lichess login could not be verified. Please try again.');
  const res = await fetchImpl(`${LICHESS_HOST}/api/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: qs({ grant_type: 'authorization_code', code, code_verifier: saved.verifier, redirect_uri: saved.redirectUri, client_id: CLIENT_ID }),
  });
  if (!res.ok) throw new ExplorerError('auth', 'Lichess did not complete the login.');
  const { access_token: token } = await res.json() as { access_token: string };
  const user = await accountName(token);
  setToken(token, user);
  return user;
}
export async function accountName(token: string): Promise<string | null> {
  try {
    const r = await fetchImpl(`${LICHESS_HOST}/api/account`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    return ((await r.json()) as { username?: string }).username ?? null;
  } catch { return null; }
}
/** Disconnect: revoke the token at Lichess (best effort) and forget it here. */
export async function logoutLichess() {
  const t = getToken();
  setToken(null);
  if (t) { try { await fetchImpl(`${LICHESS_HOST}/api/token`, { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } }); } catch { /* offline: forgotten locally anyway */ } }
}
