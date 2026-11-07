import { useState } from 'react';
import { parsePgn, type PgnImportResult } from '../chess/pgn';
import { gameFromParsed, saveGame, gameTitle } from '../services/games';
import { navigate } from '../ui/router';
import { useApp } from '../ui/context';

export function ImportPage() {
  const { toast } = useApp();
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState<PgnImportResult | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());

  const parse = (t: string) => {
    const r = parsePgn(t);
    setParsed(r);
    setSel(new Set(r.games.map((_, i) => i).filter((i) => r.games[i].moves.length > 0)));
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    const t = await f.text();
    setText(t);
    parse(t);
  };

  const importGames = async (indices: number[], open: boolean) => {
    if (!parsed) return;
    const ids: string[] = [];
    for (const i of indices) {
      const g = parsed.games[i];
      if (!g.moves.length) continue;
      const rec = gameFromParsed(g);
      await saveGame(rec);
      ids.push(rec.id);
    }
    if (!ids.length) { toast('Nothing to import.'); return; }
    toast(`Imported ${ids.length} game${ids.length === 1 ? '' : 's'}.`);
    navigate(open && ids.length === 1 ? `review/${ids[0]}` : 'library');
  };

  return (
    <div style={{ maxWidth: 980 }}>
      <h1>Import PGN</h1>
      <p className="muted">Paste PGN text or upload a <code>.pgn</code> file. Files with many games are supported; choose which to import. Headers, results, clocks, comments, annotations and variations are preserved.</p>
      <div className="card stack">
        <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={'[Event "Club game"]\n[White "…"]\n[Black "…"]\n\n1. e4 e5 2. Nf3 Nc6 …'} data-testid="pgn-text" />
        <div className="row">
          <button className="btn primary" onClick={() => parse(text)} disabled={!text.trim()} data-testid="parse-pgn">Read PGN</button>
          <label className="btn">Upload .pgn<input type="file" accept=".pgn,text/plain,application/x-chess-pgn" hidden onChange={(e) => onFile(e.target.files?.[0])} data-testid="pgn-file" /></label>
          {text && <button className="btn ghost" onClick={() => { setText(''); setParsed(null); }}>Clear</button>}
        </div>
      </div>
      {parsed && (
        <div className="card" data-testid="pgn-results">
          {parsed.errors.map((e) => <div key={e} className="notice bad">{e}</div>)}
          {parsed.games.length > 0 && (
            <>
              <div className="row between" style={{ marginBottom: 8 }}>
                <h3 style={{ margin: 0 }}>{parsed.games.length} game{parsed.games.length === 1 ? '' : 's'} found</h3>
                <div className="row">
                  {parsed.games.length > 1 && <button className="btn sm" onClick={() => setSel(new Set(parsed.games.map((_, i) => i)))}>Select all</button>}
                  <button className="btn primary sm" disabled={!sel.size} onClick={() => importGames([...sel], true)} data-testid="import-selected">Import {sel.size > 1 ? `${sel.size} games` : 'and review'}</button>
                </div>
              </div>
              <table className="list">
                <thead><tr><th /><th>Game</th><th>Event / date</th><th>Moves</th><th>Result</th><th>Status</th></tr></thead>
                <tbody>
                  {parsed.games.map((g, i) => (
                    <tr key={i}>
                      <td><input type="checkbox" checked={sel.has(i)} disabled={!g.moves.length} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(i); else n.delete(i); setSel(n); }} aria-label={`select game ${i + 1}`} /></td>
                      <td>{gameTitle({ headers: g.headers, source: 'pgn' })}{g.headers.WhiteElo || g.headers.BlackElo ? <span className="faint small"> ({g.headers.WhiteElo ?? '?'} / {g.headers.BlackElo ?? '?'})</span> : null}</td>
                      <td className="muted small">{g.headers.Event ?? ''} {g.headers.Date ?? ''} {g.headers.TimeControl ? `· ${g.headers.TimeControl}` : ''}</td>
                      <td className="mono">{Math.ceil(g.moves.length / 2)}</td>
                      <td className="mono">{g.result}</td>
                      <td className="small">
                        {g.errors.map((e) => <div key={e} style={{ color: '#f08a8d' }}>{e}</div>)}
                        {g.warnings.map((w) => <div key={w} className="faint">{w}</div>)}
                        {!g.errors.length && !g.warnings.length && <span className="pill accent">valid</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  );
}
