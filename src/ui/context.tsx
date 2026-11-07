import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { getMeta, getPrefs, setMeta, setPrefs } from '../db/db';
import { DEFAULT_PREFS, type Preferences } from '../db/types';
import { getEngine } from '../engine/instance';
import type { EngineStatus } from '../engine/controller';

interface AppCtx {
  prefs: Preferences;
  updatePrefs: (p: Partial<Preferences>) => void;
  engineStatus: EngineStatus;
  /** id of a Ranked match in progress: all assistance is locked while set */
  activeRanked: string | null;
  /** true once the stored active-match id has been read */
  rankedLoaded: boolean;
  setActiveRanked: (id: string | null) => void;
  toast: (msg: string) => void;
  toasts: { id: number; msg: string }[];
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [prefs, setP] = useState<Preferences>(DEFAULT_PREFS);
  const [engineStatus, setStatus] = useState<EngineStatus>({ ready: false, busy: false, queued: 0, restarts: 0 });
  const [activeRanked, setAR] = useState<string | null>(null);
  const [rankedLoaded, setRankedLoaded] = useState(false);
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  useEffect(() => {
    getPrefs().then(setP).catch(() => {});
    getMeta<string | null>('activeRanked').then((v) => setAR(v ?? null)).catch(() => {}).finally(() => setRankedLoaded(true));
    return getEngine().subscribe(setStatus);
  }, []);
  const updatePrefs = useCallback((p: Partial<Preferences>) => {
    setP((prev) => {
      const next = { ...prev, ...p };
      void setPrefs(next);
      return next;
    });
  }, []);
  const setActiveRanked = useCallback((id: string | null) => {
    setAR(id);
    void setMeta('activeRanked', id);
  }, []);
  const toast = useCallback((msg: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return <Ctx.Provider value={{ prefs, updatePrefs, engineStatus, activeRanked, rankedLoaded, setActiveRanked, toast, toasts }}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('AppProvider missing');
  return c;
}
