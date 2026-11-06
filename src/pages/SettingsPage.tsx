import { useEffect, useState } from 'react';
import { useApp } from '../ui/context';
import { clearEngineCache, deleteAllData, exportAll, importBackup, storageEstimate, DB_VERSION } from '../db/db';
import { downloadText, Modal } from '../ui/bits';
import { getEngine } from '../engine/instance';
import { OPENING_COUNT } from '../analysis/openings';

const QUALITY = [
  { id: 'fast', label: 'Fast', quick: 8, deep: 12, live: 10 },
  { id: 'balanced', label: 'Balanced', quick: 10, deep: 16, live: 12 },
  { id: 'deep', label: 'Deep', quick: 12, deep: 20, live: 14 },
];

export function SettingsPage() {
  const { prefs, updatePrefs, engineStatus, toast, activeRanked } = useApp();
  const [est, setEst] = useState<{ usage?: number; quota?: number }>({});
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);
  useEffect(() => { storageEstimate().then(setEst); }, []);
  const q = QUALITY.find((x) => x.quick === prefs.quickDepth && x.deep === prefs.deepDepth && x.live === prefs.liveDepth)?.id ?? 'custom';
  return (
    <div style={{ maxWidth: 820 }}>
      <h1>Settings & data</h1>
      <div className="card stack">
        <h3>Analysis quality</h3>
        <div className="segmented">{QUALITY.map((x) => <button key={x.id} className={q === x.id ? 'on' : ''} onClick={() => updatePrefs({ quickDepth: x.quick, deepDepth: x.deep, liveDepth: x.live })}>{x.label}</button>)}</div>
        <div className="grid2" style={{ gap: 8 }}>
          <label className="field">Review quick pass depth<input type="number" min={4} max={30} value={prefs.quickDepth} onChange={(e) => updatePrefs({ quickDepth: +e.target.value })} /></label>
          <label className="field">Review deep pass depth<input type="number" min={6} max={40} value={prefs.deepDepth} onChange={(e) => updatePrefs({ deepDepth: +e.target.value })} /></label>
          <label className="field">Live (Coach / exploration) depth<input type="number" min={4} max={30} value={prefs.liveDepth} onChange={(e) => updatePrefs({ liveDepth: +e.target.value })} /></label>
        </div>
        <p className="faint small">Every review first runs a quick pass (results marked provisional), then a deep pass that replaces them. Results are cached per position, so transpositions and repeated reviews are fast.</p>
        <div className="row small">
          <span>Engine: {engineStatus.name ?? 'Stockfish'} · {engineStatus.ready ? 'ready' : 'loading'} · restarts {engineStatus.restarts}</span>
          <button className="btn sm" onClick={() => void getEngine().restart()} disabled={!!activeRanked}>Restart engine</button>
          <button className="btn sm" onClick={async () => { await clearEngineCache(); getEngine().clearMemoryCache(); toast('Analysis cache cleared.'); }}>Clear analysis cache</button>
        </div>
      </div>
      <div className="card stack">
        <h3>Board & training</h3>
        <label className="check"><input type="checkbox" checked={prefs.showLegalMoves} onChange={(e) => updatePrefs({ showLegalMoves: e.target.checked })} /> Show legal destination squares for the selected piece</label>
        <label className="check"><input type="checkbox" checked={prefs.showCoordinates} onChange={(e) => updatePrefs({ showCoordinates: e.target.checked })} /> Show coordinates</label>
        <label className="check"><input type="checkbox" checked={prefs.predictionExercises} onChange={(e) => updatePrefs({ predictionExercises: e.target.checked })} /> Allow Predict the Opponent exercises in Coach games</label>
        <label className="check"><input type="checkbox" checked={prefs.confirmResign} onChange={(e) => updatePrefs({ confirmResign: e.target.checked })} /> Ask before resigning</label>
        <div className="row"><span>Board colours</span><div className="segmented">{(['moss', 'slate', 'sand'] as const).map((t) => <button key={t} className={prefs.boardTheme === t ? 'on' : ''} onClick={() => updatePrefs({ boardTheme: t })}>{t}</button>)}</div></div>
      </div>
      <div className="card stack">
        <h3>Your data</h3>
        <p className="small muted">Everything is stored only in this browser (IndexedDB, schema v{DB_VERSION}). {est.usage !== undefined ? `Using ${(est.usage / 1048576).toFixed(1)} MB${est.quota ? ` of ${(est.quota / 1073741824).toFixed(1)} GB available` : ''}.` : ''}</p>
        <div className="row">
          <button className="btn" onClick={async () => downloadText(`chess-of-life-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(await exportAll()), 'application/json')} data-testid="export-backup">Export backup</button>
          <label className="btn">Import backup<input type="file" accept="application/json,.json" hidden onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try { const rep = await importBackup(JSON.parse(await f.text())); setImportMsg(`Imported: ${Object.entries(rep.imported).map(([k, v]) => `${v} ${k}`).join(', ')}. Reload to see everything.`); }
            catch (err) { setImportMsg(`Import failed: ${(err as Error).message}`); }
          }} /></label>
          <span className="spacer" />
          <button className="btn danger" onClick={() => setConfirmDelete(true)}>Delete all data</button>
        </div>
        {importMsg && <div className="notice small">{importMsg}</div>}
      </div>
      <div className="card small">
        <h3>About & licences</h3>
        <p>Chess of Life runs entirely on your device. No accounts, no servers, no tracking.</p>
        <ul style={{ paddingLeft: 18 }}>
          <li><b>Stockfish 17.1</b> (WebAssembly build “lite, single-threaded” from the stockfish.js project) — GNU GPL v3. Source: github.com/official-stockfish/Stockfish and github.com/nmrugg/stockfish.js. The licence text ships with the app at <a href="./engine/COPYING.txt" target="_blank" rel="noreferrer">engine/COPYING.txt</a>.</li>
          <li><b>Opening reference</b>: {OPENING_COUNT} catalogued lines from lichess-org/chess-openings — CC0 1.0.</li>
          <li><b>Piece set</b>: “Cburnett” SVG pieces by Colin M.L. Burnett (via react-chessboard) — CC BY-SA 3.0.</li>
          <li>chess.js (BSD-2-Clause), React (MIT), idb (ISC), react-chessboard (MIT).</li>
        </ul>
        <p className="faint">Move classifications, accuracy and ratings use Chess of Life’s own documented methods; they are not Chess.com or Lichess numbers.</p>
      </div>
      {confirmDelete && (
        <Modal onClose={() => setConfirmDelete(false)}>
          <h2>Delete all data?</h2>
          <p className="muted">Games, reviews, branches, Coach history, learning profile, Ranked history, Rival model and settings will be permanently removed from this browser.</p>
          <div className="row"><span className="spacer" /><button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button><button className="btn danger" onClick={async () => { await deleteAllData(); window.location.hash = '#/home'; window.location.reload(); }}>Delete everything</button></div>
        </Modal>
      )}
    </div>
  );
}
