import { useState } from 'react';
import { parsePgn, type PgnImportResult } from '../chess/pgn';
import { gameFromParsed, saveGame, gameTitle } from '../services/games';
import { navigate } from '../ui/router';
import { useApp } from '../ui/context';
import { IconFile, IconUpload } from '../ui/icons';
import { prettyDate } from '../util/format';

export function ImportPage() {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<PgnImportResult | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [over, setOver] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const parse = (t: string) => {
    const r = parsePgn(t);
    setParsed(r);
    setSel(new Set(r.games.map((_, i) => i).filter((i) => r.games[i].moves.length > 0)));
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const t = await f.text();
    setFileName(f.name);
    setText(t);
    parse(t);
  };
  const importGames = async () => {
    if (!parsed) return;
    setBusy(true);
    const ids: string[] = [];
    for (const i of [...sel].sort((a, b) => a - b)) {
      const g = parsed.games[i];
      if (!g.moves.length) continue;
      const rec = gameFromParsed(g);
      await saveGame(rec);
      ids.push(rec.id);
    }
    setBusy(false);
    if (!ids.length) { toast('Select at least one game with moves.'); return; }
    toast(`Imported ${ids.length} game${ids.length === 1 ? '' : 's'}.`);
    navigate(ids.length === 1 ? `review/${ids[0]}` : 'library');
  };
  const games = parsed?.games ?? [];
  const importable = games.filter((g) => g.moves.length > 0).length;

  return (
    <div className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Import PGN</h1>
          <div className="lede">Paste PGN text or drop a .pgn file. Headers, results, clocks, comments, annotations and variations are kept.</div>
        </div>
      </header>
      <div className="stack">
        <div className={`dropzone${over ? ' is-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void onFile(e.dataTransfer.files[0]); }}>
          <div className="row" style={{ justifyContent: 'center', gap: 'var(--s-3)' }}>
            <IconUpload size={22} />
            <span>Drop a .pgn file here, or</span>
            <label className="btn btn-sm">Choose a file<input type="file" accept=".pgn,text/plain,application/x-chess-pgn" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} data-testid="pgn-file" /></label>
          </div>
          {fileName && <div className="small faint" style={{ marginTop: 'var(--s-2)' }}><IconFile size={14} /> {fileName}</div>}
        </div>
        <label className="field">
          <span className="field-label">PGN text</span>
          <textarea className="textarea" rows={9} value={text} spellCheck={false}
            onChange={(e) => { setText(e.target.value); setFileName(null); }}
            onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t && !text.trim()) setTimeout(() => parse(t), 0); }}
            placeholder={'[White "Your name"]\n[Black "Opponent"]\n\n1. e4 e5 2. Nf3 Nc6 …'} data-testid="pgn-text" />
          <span className="field-hint">Pasting into an empty box reads the games straight away.</span>
        </label>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={() => parse(text)} disabled={!text.trim()} data-testid="parse-pgn" title={text.trim() ? undefined : 'Paste PGN text or choose a file first'}>Read games</button>
          {text && <button type="button" className="btn btn-quiet" onClick={() => { setText(''); setParsed(null); setFileName(null); }}>Clear</button>}
        </div>

        {parsed && (
          <section className="surface" data-testid="pgn-results" aria-live="polite">
            {parsed.errors.map((e) => <div key={e} className="notice is-error" style={{ margin: 'var(--s-3)' }}>{e}</div>)}
            {games.length > 0 && (
              <>
                <div className="row" style={{ padding: 'var(--s-4) var(--s-4) var(--s-2)' }}>
                  <h2>{games.length} game{games.length === 1 ? '' : 's'} found</h2>
                  <span className="dim small">{importable < games.length ? `${games.length - importable} without moves` : ''}</span>
                  <span className="spacer" />
                  {games.length > 1 && <button type="button" className="btn btn-sm btn-quiet" onClick={() => setSel(sel.size === importable ? new Set() : new Set(games.map((_, i) => i).filter((i) => games[i].moves.length)))}>{sel.size === importable ? 'Select none' : 'Select all'}</button>}
                  <button type="button" className="btn btn-primary" disabled={!sel.size || busy} onClick={importGames} data-testid="import-selected">
                    {sel.size === 1 ? 'Import and review' : `Import ${sel.size} games`}
                  </button>
                </div>
                <div className="lib-list">
                  {games.map((g, i) => (
                    <label key={i} className="import-row">
                      <input type="checkbox" checked={sel.has(i)} disabled={!g.moves.length} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(i); else n.delete(i); setSel(n); }} />
                      <span style={{ minWidth: 0 }}>
                        <span className="lib-title">{gameTitle({ headers: g.headers, source: 'pgn' })}{g.headers.WhiteElo || g.headers.BlackElo ? <span className="faint small" style={{ fontWeight: 500 }}> ({g.headers.WhiteElo ?? '?'} vs {g.headers.BlackElo ?? '?'})</span> : null}</span>
                        <span className="small dim">{[g.headers.Event, prettyDate(g.headers.Date), g.headers.TimeControl ? `time control ${g.headers.TimeControl}` : null, `${Math.ceil(g.moves.length / 2)} moves`, g.result].filter((x) => x && x !== '?' && x !== '????.??.??').join(', ')}</span>
                        {g.errors.map((e) => <span key={e} className="small" style={{ display: 'block', color: '#f0857f' }}>{e}</span>)}
                        {g.warnings.map((w) => <span key={w} className="small faint" style={{ display: 'block' }}>{w}</span>)}
                      </span>
                      <span className="small" style={{ color: g.errors.length ? '#f0857f' : g.warnings.length ? 'var(--warn)' : 'var(--ok)', whiteSpace: 'nowrap' }}>{g.errors.length ? 'Partly read' : g.warnings.length ? 'Read with notes' : 'Ready'}</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
