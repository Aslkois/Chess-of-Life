import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AnalysisCache, AnalysisResult } from '../engine/controller';
import type { LearningProfile } from '../coach/profile';
import type { RivalModel } from '../rival/model';
import type {
  CoachAttempt, CoachSession, GameRecord, PredictionRecord, Preferences, RankedMatch, RankedProfile,
  ReconstructionDraft, RivalAdaptation, StoredReview,
} from './types';
import { DEFAULT_PREFS } from './types';

export const DB_NAME = 'chess-of-life';
export const DB_VERSION = 1;

interface Schema extends DBSchema {
  games: { key: string; value: GameRecord; indexes: { byCreated: number; bySource: string } };
  drafts: { key: string; value: ReconstructionDraft };
  reviews: { key: string; value: StoredReview };
  engineCache: { key: string; value: { key: string; result: AnalysisResult; ts: number } };
  coachSessions: { key: string; value: CoachSession; indexes: { byCreated: number } };
  coachAttempts: { key: string; value: CoachAttempt; indexes: { bySession: string } };
  predictions: { key: string; value: PredictionRecord; indexes: { bySession: string } };
  profiles: { key: string; value: LearningProfile | RivalModel | RankedProfile };
  rankedMatches: { key: string; value: RankedMatch; indexes: { byCreated: number } };
  rivalAdaptations: { key: string; value: RivalAdaptation; indexes: { byMatch: string } };
  prefs: { key: string; value: { key: string; value: unknown } };
}

export type StoreName = 'games' | 'drafts' | 'reviews' | 'engineCache' | 'coachSessions' | 'coachAttempts' | 'predictions' | 'profiles' | 'rankedMatches' | 'rivalAdaptations' | 'prefs';
export const STORES: StoreName[] = ['games', 'drafts', 'reviews', 'engineCache', 'coachSessions', 'coachAttempts', 'predictions', 'profiles', 'rankedMatches', 'rivalAdaptations', 'prefs'];

/**
 * Ordered schema migrations. migrations[v] upgrades a database from version v
 * to v+1. Add new entries (never edit old ones) when the schema changes.
 */
const migrations: ((db: IDBPDatabase<Schema>) => void)[] = [
  // 0 -> 1: initial schema
  (db) => {
    const games = db.createObjectStore('games', { keyPath: 'id' });
    games.createIndex('byCreated', 'createdAt');
    games.createIndex('bySource', 'source');
    db.createObjectStore('drafts', { keyPath: 'id' });
    db.createObjectStore('reviews', { keyPath: 'gameId' });
    db.createObjectStore('engineCache', { keyPath: 'key' });
    db.createObjectStore('coachSessions', { keyPath: 'id' }).createIndex('byCreated', 'createdAt');
    db.createObjectStore('coachAttempts', { keyPath: 'id' }).createIndex('bySession', 'sessionId');
    db.createObjectStore('predictions', { keyPath: 'id' }).createIndex('bySession', 'sessionId');
    db.createObjectStore('profiles', { keyPath: 'id' });
    db.createObjectStore('rankedMatches', { keyPath: 'id' }).createIndex('byCreated', 'createdAt');
    db.createObjectStore('rivalAdaptations', { keyPath: 'id' }).createIndex('byMatch', 'matchId');
    db.createObjectStore('prefs', { keyPath: 'key' });
  },
];

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function getDb(): Promise<IDBPDatabase<Schema>> {
  if (!dbp) {
    dbp = openDB<Schema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        for (let v = oldVersion; v < DB_VERSION; v++) migrations[v](db);
      },
      blocked() { /* another tab holds an old version */ },
      terminated() { dbp = null; },
    });
  }
  return dbp;
}

/** For tests: close and forget the connection. */
export async function closeDb() {
  if (dbp) (await dbp).close();
  dbp = null;
}

// ---------- generic helpers ----------
export async function put<S extends StoreName>(store: S, value: Schema[S]['value']) {
  const db = await getDb();
  await db.put(store, value as never);
}
export async function get<S extends StoreName>(store: S, key: string): Promise<Schema[S]['value'] | undefined> {
  const db = await getDb();
  return db.get(store, key) as Promise<Schema[S]['value'] | undefined>;
}
export async function del(store: StoreName, key: string) {
  const db = await getDb();
  await db.delete(store, key);
}
export async function all<S extends StoreName>(store: S): Promise<Schema[S]['value'][]> {
  const db = await getDb();
  return db.getAll(store) as Promise<Schema[S]['value'][]>;
}

// ---------- domain helpers ----------
export async function listGames(): Promise<GameRecord[]> {
  const games = await all('games');
  return games.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteGame(id: string) {
  const db = await getDb();
  const tx = db.transaction(['games', 'reviews'], 'readwrite');
  await tx.objectStore('games').delete(id);
  await tx.objectStore('reviews').delete(id);
  await tx.done;
}

export async function attemptsForSession(sessionId: string): Promise<CoachAttempt[]> {
  const db = await getDb();
  return db.getAllFromIndex('coachAttempts', 'bySession', sessionId);
}

export async function predictionsForSession(sessionId: string): Promise<PredictionRecord[]> {
  const db = await getDb();
  return db.getAllFromIndex('predictions', 'bySession', sessionId);
}

export async function getPrefs(): Promise<Preferences> {
  const rec = await get('prefs', 'preferences');
  return { ...DEFAULT_PREFS, ...((rec?.value as Partial<Preferences>) ?? {}) };
}
export async function setPrefs(p: Preferences) {
  await put('prefs', { key: 'preferences', value: p });
}
export async function getMeta<T>(key: string): Promise<T | undefined> {
  const rec = await get('prefs', `meta:${key}`);
  return rec?.value as T | undefined;
}
export async function setMeta(key: string, value: unknown) {
  await put('prefs', { key: `meta:${key}`, value });
}

/** IndexedDB-backed engine analysis cache (shared across games: keys are transposition-safe). */
export const persistentAnalysisCache: AnalysisCache = {
  async get(key) {
    try {
      const rec = await get('engineCache', key);
      return rec?.result;
    } catch {
      return undefined;
    }
  },
  async set(key, result) {
    try {
      await put('engineCache', { key, result, ts: Date.now() });
    } catch { /* quota or private mode: caching is best effort */ }
  },
};

// ---------- backup ----------
export interface Backup {
  app: 'chess-of-life';
  format: 1;
  dbVersion: number;
  exportedAt: string;
  stores: Partial<Record<StoreName, unknown[]>>;
}

export async function exportAll(includeEngineCache = false): Promise<Backup> {
  const stores: Backup['stores'] = {};
  for (const s of STORES) {
    if (s === 'engineCache' && !includeEngineCache) continue;
    stores[s] = await all(s);
  }
  return { app: 'chess-of-life', format: 1, dbVersion: DB_VERSION, exportedAt: new Date().toISOString(), stores };
}

export interface ImportReport { imported: Record<string, number>; skipped: string[] }

export async function importBackup(data: unknown, mode: 'merge' | 'replace' = 'merge'): Promise<ImportReport> {
  const b = data as Backup;
  if (!b || b.app !== 'chess-of-life' || typeof b.stores !== 'object') throw new Error('This file is not a Chess of Life backup.');
  if (b.format !== 1) throw new Error(`Unsupported backup format ${b.format}.`);
  if (b.dbVersion > DB_VERSION) throw new Error('This backup was made by a newer version of Chess of Life.');
  const db = await getDb();
  const report: ImportReport = { imported: {}, skipped: [] };
  const keyPath: Record<StoreName, string> = {
    games: 'id', drafts: 'id', reviews: 'gameId', engineCache: 'key', coachSessions: 'id', coachAttempts: 'id', predictions: 'id', profiles: 'id', rankedMatches: 'id', rivalAdaptations: 'id', prefs: 'key',
  };
  const tx = db.transaction(STORES, 'readwrite');
  for (const s of STORES) {
    const rows = b.stores[s];
    if (!rows) continue;
    if (!Array.isArray(rows)) { report.skipped.push(s); continue; }
    if (mode === 'replace') await tx.objectStore(s).clear();
    let n = 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || !(keyPath[s] in (row as object))) continue;
      await tx.objectStore(s).put(row as never);
      n++;
    }
    report.imported[s] = n;
  }
  await tx.done;
  return report;
}

export async function deleteAllData() {
  const db = await getDb();
  const tx = db.transaction(STORES, 'readwrite');
  for (const s of STORES) await tx.objectStore(s).clear();
  await tx.done;
}

export async function clearEngineCache() {
  const db = await getDb();
  await db.clear('engineCache');
}

export async function storageEstimate(): Promise<{ usage?: number; quota?: number }> {
  try {
    return (await navigator.storage?.estimate?.()) ?? {};
  } catch {
    return {};
  }
}
