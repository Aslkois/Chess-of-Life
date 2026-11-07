import { useEffect, useState } from 'react';
import { useApp } from '../ui/context';
import { clearEngineCache, deleteAllData, exportAll, importBackup, storageEstimate, DB_VERSION } from '../db/db';
import { downloadText } from '../ui/bits';
import { ConfirmDialog } from '../ui/Dialog';
import { BOARD_THEMES, MiniBoard, type BoardTheme } from '../ui/Board';
import { getEngine } from '../engine/instance';
import { OPENING_COUNT } from '../analysis/openings';

const QUALITY = [
  { id: 'fast', label: 'Fast', quick: 8, deep: 12, live: 10, desc: 'Quick reviews on any device. Fine for spotting blunders.' },
  { id: 'balanced', label: 'Balanced', quick: 10, deep: 16, live: 12, desc: 'Recommended. A short game reviews in about a minute.' },
  { id: 'deep', label: 'Deep', quick: 12, deep: 20, live: 14, desc: 'Most reliable ratings. Reviews take several times longer.' },
];

export function SettingsPage() {
  const { prefs, updatePrefs, engineStatus, toast, activeRanked } = useApp();
  const [est, setEst] = useState<{ usage?: number; quota?: number }>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importMsg, setImportMsg] = useState<{ text: string; ok: boolean } | null>(null);
  useEffect(() => { storageEstimate().then(setEst); }, []);
  const q = QUALITY.find((x) => x.quick === prefs.quickDepth && x.deep === prefs.deepDepth && x.live === prefs.liveDepth);
  const num = (key: 'quickDepth' | 'deepDepth' | 'liveDepth', label: string, min: number, max: number) => (
    <label className="field">
      <span className="field-label">{label}</span>
      <div className="row-nowrap">
        <button type="button" className="btn btn-icon" onClick={() => updatePrefs({ [key]: Math.max(min, prefs[key] - 1) })} aria-label={`Decrease ${label}`} disabled={prefs[key] <= min}>−</button>
        <input className="input num" style={{ width: 64, textAlign: 'center' }} type="number" min={min} max={max} value={prefs[key]} onChange={(e) => updatePrefs({ [key]: Math.max(min, Math.min(max, +e.target.value || min)) })} />
        <button type="button" className="btn btn-icon" onClick={() => updatePrefs({ [key]: Math.min(max, prefs[key] + 1) })} aria-label={`Increase ${label}`} disabled={prefs[key] >= max}>+</button>
      </div>
    </label>
  );

  return (
    <div className="page page-narrow">
      <header className="page-head"><div><h1>Settings</h1><div className="lede">Everything is stored in this browser only.</div></div></header>

      <section className="settings-group" aria-labelledby="s-analysis">
        <header><h2 id="s-analysis">Analysis</h2><p>How deeply Stockfish searches. Reviews always run a quick pass first, then a deeper one that replaces it.</p></header>
        <div className="stack">
          <div className="seg" role="group" aria-label="Analysis quality">
            {QUALITY.map((x) => <button key={x.id} type="button" aria-pressed={q?.id === x.id} onClick={() => updatePrefs({ quickDepth: x.quick, deepDepth: x.deep, liveDepth: x.live })}>{x.label}</button>)}
          </div>
          <p className="small dim" style={{ margin: 0 }}>{q ? q.desc : 'Custom depths.'}</p>
          <details className="disclose">
            <summary>Exact search depths</summary>
            <div className="row" style={{ gap: 'var(--s-5)', marginTop: 'var(--s-3)' }}>
              {num('quickDepth', 'Quick pass', 4, 30)}
              {num('deepDepth', 'Deep pass', 6, 40)}
              {num('liveDepth', 'Coach and exploring', 4, 30)}
            </div>
          </details>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="s-board">
        <header><h2 id="s-board">Board</h2><p>Applies to every board in the app.</p></header>
        <div className="stack">
          <div className="theme-grid" role="group" aria-label="Board colours">
            {(Object.keys(BOARD_THEMES) as BoardTheme[]).map((t) => (
              <button key={t} type="button" className="theme-opt" aria-pressed={prefs.boardTheme === t} onClick={() => updatePrefs({ boardTheme: t })}>
                <MiniBoard theme={t} />
                {BOARD_THEMES[t].label}
              </button>
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={prefs.showCoordinates} onChange={(e) => updatePrefs({ showCoordinates: e.target.checked })} /><span className="check-text">Show coordinates<small>Files and ranks along the board edge.</small></span></label>
          <label className="check"><input type="checkbox" checked={prefs.showLegalMoves} onChange={(e) => updatePrefs({ showLegalMoves: e.target.checked })} /><span className="check-text">Show legal moves<small>Dots on the squares the selected piece can reach. This is rules help, not engine help, so it stays on in Ranked games.</small></span></label>
          <label className="check"><input type="checkbox" checked={prefs.motion === 'reduced'} onChange={(e) => updatePrefs({ motion: e.target.checked ? 'reduced' : 'system' })} /><span className="check-text">Reduce motion<small>Pieces jump instead of sliding and move ratings appear without animation. Your system setting is respected either way.</small></span></label>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="s-play">
        <header><h2 id="s-play">Coach and Ranked</h2></header>
        <div className="stack">
          <label className="check"><input type="checkbox" checked={prefs.predictionExercises} onChange={(e) => updatePrefs({ predictionExercises: e.target.checked })} /><span className="check-text">Predict the Opponent exercises<small>Let the Coach ask what you expect at important moments.</small></span></label>
          <label className="check"><input type="checkbox" checked={prefs.confirmResign} onChange={(e) => updatePrefs({ confirmResign: e.target.checked })} /><span className="check-text">Ask before resigning a Ranked game</span></label>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="s-engine">
        <header><h2 id="s-engine">Engine</h2><p>{engineStatus.name ?? 'Stockfish'}, running on this device.</p></header>
        <div className="stack">
          <p className="small" style={{ margin: 0 }}>{engineStatus.error ?? (engineStatus.ready ? 'Ready.' : 'Loading…')} {engineStatus.restarts ? `Restarted ${engineStatus.restarts} time${engineStatus.restarts === 1 ? '' : 's'} this session.` : ''}</p>
          <div className="row">
            <button type="button" className="btn" onClick={() => void getEngine().restart()} disabled={!!activeRanked} title={activeRanked ? 'Not available during a Ranked game' : 'Stop all searches and start a fresh engine'}>Restart engine</button>
            <button type="button" className="btn btn-quiet" onClick={async () => { await clearEngineCache(); getEngine().clearMemoryCache(); toast('Analysis cache cleared.'); }}>Clear analysis cache</button>
          </div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="s-data">
        <header><h2 id="s-data">Your data</h2><p>IndexedDB, schema version {DB_VERSION}. {est.usage !== undefined ? `${(est.usage / 1048576).toFixed(1)} MB used.` : ''}</p></header>
        <div className="stack">
          <div className="row">
            <button type="button" className="btn" onClick={async () => { downloadText(`chess-of-life-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await exportAll()), 'application/json'); toast('Backup downloaded.'); }} data-testid="export-backup">Download a backup</button>
            <label className="btn">Restore from a backup<input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              try { const rep = await importBackup(JSON.parse(await f.text())); setImportMsg({ ok: true, text: `Restored ${Object.entries(rep.imported).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ')}. Reload the page to see everything.` }); }
              catch (err) { setImportMsg({ ok: false, text: `Could not restore: ${(err as Error).message}` }); }
            }} /></label>
          </div>
          {importMsg && <div className={`notice ${importMsg.ok ? 'is-ok' : 'is-error'}`} role="status">{importMsg.text}</div>}
          <div><button type="button" className="btn btn-danger" onClick={() => setConfirmDelete(true)}>Delete all data</button></div>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="s-about">
        <header><h2 id="s-about">About</h2></header>
        <div className="small dim stack" style={{ gap: 'var(--s-2)' }}>
          <p>Chess of Life runs entirely on your device: no accounts, servers or tracking.</p>
          <p><b>Stockfish 17.1</b> (lite single-threaded WebAssembly build from stockfish.js), GPL-3.0. Licence text: <a href="./engine/COPYING.txt" target="_blank" rel="noreferrer">engine/COPYING.txt</a>.</p>
          <p>Opening reference: {OPENING_COUNT} lines from lichess-org/chess-openings, CC0. Pieces: Cburnett set, CC BY-SA 3.0. Typeface: Bricolage Grotesque, SIL Open Font License. chess.js (BSD-2-Clause), React (MIT), idb (ISC), react-chessboard (MIT).</p>
          <p className="faint">Move ratings, accuracy and the Ranked rating use Chess of Life's own documented methods, not Chess.com or Lichess numbers.</p>
        </div>
      </section>

      <ConfirmDialog open={confirmDelete} title="Delete all data?" danger
        body="Games, reviews, branches, Coach history, your learning profile, Ranked history, the Rival's model and settings will be removed from this browser. Download a backup first if you might want them back."
        confirmLabel="Delete everything" cancelLabel="Keep my data" onCancel={() => setConfirmDelete(false)}
        onConfirm={async () => { await deleteAllData(); window.location.hash = '#/home'; window.location.reload(); }} />
    </div>
  );
}
