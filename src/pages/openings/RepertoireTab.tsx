import { Chess } from 'chess.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '../../ui/router';
import { useApp } from '../../ui/context';
import { ConfirmDialog, Dialog } from '../../ui/Dialog';
import { downloadText } from '../../ui/bits';
import { IconDownload, IconPlay, IconTrash, IconUpload } from '../../ui/icons';
import { formatLine } from '../../analysis/explain';
import { fensOf, trackOpening } from '../../analysis/openings';
import type { DrillRecord, RepertoireLine } from '../../db/types';
import { buildRepertoire, conflicts, forgotten, weakness } from '../../openings/repertoire';
import { addLine, deleteLine, linesFromPgn, listDrills, listLines, repertoireToPgn, updateLine } from '../../services/repertoire';
import { pathParam } from './paths';

const START = new Chess().fen();
const uciPath = (sans: string[]) => { const c = new Chess(); return sans.map((s) => { const m = c.move(s); return m.from + m.to + (m.promotion ?? ''); }); };

export function RepertoireTab() {
  const { toast } = useApp();
  const [lines, setLines] = useState<RepertoireLine[] | null>(null);
  const [drills, setDrills] = useState<DrillRecord[]>([]);
  const [del, setDel] = useState<RepertoireLine | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const reload = async () => { setLines(await listLines()); setDrills(await listDrills()); };
  useEffect(() => { void reload(); }, []);

  if (!lines) return <div className="empty">Loading…</div>;
  const byColor = (c: 'w' | 'b') => lines.filter((l) => l.color === c);
  return (
    <div className="stack" style={{ gap: 'var(--s-6)' }}>
      <div className="row">
        <p className="small dim" style={{ margin: 0, flex: 1, minWidth: 260 }}>Save lines from the Explorer (“Add to repertoire”), then practise them against a training opponent. Practice is kept apart from your game statistics and never changes your rating.</p>
        <button type="button" className="btn btn-sm" onClick={() => setImportOpen(true)} data-testid="import-repertoire"><IconUpload size={16} /> Import PGN</button>
        <button type="button" className="btn btn-sm" disabled={!lines.length} onClick={() => downloadText('repertoire.pgn', repertoireToPgn(lines), 'application/x-chess-pgn')} data-testid="export-repertoire"><IconDownload size={16} /> Export PGN</button>
      </div>
      {lines.length === 0 && (
        <div className="surface surface-pad stack" data-testid="repertoire-empty">
          <h2>No lines yet</h2>
          <p className="small dim" style={{ margin: 0 }}>Open the Explorer, play the moves of a line you want to learn and choose “Add to repertoire”.</p>
          <div><button type="button" className="btn btn-primary" onClick={() => navigate('openings/explore')}>Open the Explorer</button></div>
        </div>
      )}
      <div className="grid-2" style={{ alignItems: 'start' }}>
        {(['w', 'b'] as const).map((c) => byColor(c).length > 0 && (
          <RepertoireColumn key={c} color={c} lines={byColor(c)} drills={drills.filter((d) => d.color === c)} onDelete={setDel}
            onRename={async (l, name) => { await updateLine({ ...l, name }); await reload(); }} />
        ))}
      </div>
      <ConfirmDialog open={!!del} title="Delete this line?" body={del ? `“${del.name}” is removed from your repertoire. Practice records for its positions are kept.` : ''} danger confirmLabel="Delete line" cancelLabel="Keep it"
        onCancel={() => setDel(null)} onConfirm={async () => { if (del) await deleteLine(del.id); setDel(null); await reload(); }} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} onImport={async (ls) => {
        let n = 0;
        for (const l of ls) { try { await addLine(l.name, l.color, l.moves); n++; } catch { /* reported by the dialog */ } }
        setImportOpen(false);
        toast(`Imported ${n} line${n === 1 ? '' : 's'}.`);
        await reload();
      }} />
    </div>
  );
}

function RepertoireColumn({ color, lines, drills, onDelete, onRename }: { color: 'w' | 'b'; lines: RepertoireLine[]; drills: DrillRecord[]; onDelete: (l: RepertoireLine) => void; onRename: (l: RepertoireLine, name: string) => void }) {
  const idx = useMemo(() => buildRepertoire(lines, color), [lines, color]);
  const clash = conflicts(idx);
  const weak = forgotten(drills).slice(0, 6);
  const side = color === 'w' ? 'White' : 'Black';
  return (
    <section className="surface surface-pad stack" aria-label={`${side} repertoire`} data-testid={`repertoire-${color}`}>
      <div className="row-nowrap">
        <h2 style={{ margin: 0 }}>As {side}</h2>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-primary" onClick={() => navigate(`openings/practice/${color}`)} data-testid={`practise-${color}`}><IconPlay size={14} /> Practise all</button>
      </div>
      <ul className="rep-lines">
        {lines.map((l) => <LineRow key={l.id} line={l} onDelete={() => onDelete(l)} onRename={(n) => onRename(l, n)} />)}
      </ul>
      {clash.length > 0 && (
        <p className="xs" style={{ margin: 0 }} data-testid="rep-conflict">Your lines disagree in {clash.length} position{clash.length === 1 ? '' : 's'} ({clash.map((c) => c.moves.join(' or ')).join('; ')}). Practice accepts any of your prepared moves there.</p>
      )}
      {weak.length > 0 && (
        <div data-testid="forgotten">
          <h3 className="section-title">Moves you tend to forget</h3>
          <ul className="op-games">
            {weak.map((d) => {
              const san = (() => { try { return d.expected.map((u) => new Chess(d.fen).move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }).san).join(' or '); } catch { return d.expected.join(', '); } })();
              return <li key={d.id}><span><b>{san}</b> <span className="faint xs">missed {d.misses} of {d.attempts}, {d.streak ? `${d.streak} right in a row since` : 'not yet fixed'}</span></span><span className="xs faint">weakness {weakness(d).toFixed(1)}</span></li>;
            })}
          </ul>
          <p className="xs faint" style={{ margin: 0 }}>Practice leads you to these positions more often until you get them right repeatedly.</p>
        </div>
      )}
    </section>
  );
}

function LineRow({ line, onDelete, onRename }: { line: RepertoireLine; onDelete: () => void; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(line.name);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  const t = useMemo(() => trackOpening(fensOf(line.moves)), [line.moves]);
  const ucis = useMemo(() => uciPath(line.moves), [line.moves]);
  return (
    <li className="rep-line" data-testid="rep-line">
      <div className="rep-line-head">
        {editing ? (
          <form onSubmit={(e) => { e.preventDefault(); setEditing(false); if (name.trim() && name !== line.name) onRename(name.trim()); }} style={{ flex: 1 }}>
            <input ref={ref} className="input input-sm" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => { setEditing(false); if (name.trim() && name !== line.name) onRename(name.trim()); }} aria-label="Line name" />
          </form>
        ) : <button type="button" className="rep-name" onClick={() => setEditing(true)} title="Rename">{line.name}</button>}
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => navigate(`openings/explore/${pathParam(ucis)}`)}>Open</button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => navigate(`openings/practice/${line.color}:${line.id}`)}>Practise</button>
        <button type="button" className="btn btn-sm btn-quiet btn-icon" onClick={onDelete} aria-label={`Delete ${line.name}`}><IconTrash size={16} /></button>
      </div>
      <div className="small dim">{formatLine(START, line.moves)}</div>
      {t.opening && <div className="xs faint">{t.opening.eco} {t.opening.name}{t.leftAt !== null ? ' · continues beyond the catalogued theory' : ''}</div>}
    </li>
  );
}

function ImportDialog({ open, onClose, onImport }: { open: boolean; onClose: () => void; onImport: (lines: { name: string; color: 'w' | 'b'; moves: string[] }[]) => void }) {
  const [text, setText] = useState('');
  const [color, setColor] = useState<'w' | 'b'>('w');
  const parsed = useMemo(() => (text.trim() ? linesFromPgn(text, color) : null), [text, color]);
  return (
    <Dialog open={open} onClose={onClose} title="Import repertoire lines" description="Paste PGN. Each game becomes one line (its main line). A RepertoireColor header sets the side; otherwise the side below is used." wide
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" disabled={!parsed?.lines.length} onClick={() => parsed && onImport(parsed.lines)}>Import {parsed?.lines.length ?? 0} line{parsed?.lines.length === 1 ? '' : 's'}</button></>}>
      <div className="stack">
        <textarea className="input" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'[Event "Repertoire: Italian"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 *'} data-autofocus />
        <div className="seg" role="group" aria-label="Side for lines without a RepertoireColor header">
          <button type="button" aria-pressed={color === 'w'} onClick={() => setColor('w')}>White</button>
          <button type="button" aria-pressed={color === 'b'} onClick={() => setColor('b')}>Black</button>
        </div>
        {parsed?.errors.map((e, i) => <p key={i} className="xs" style={{ margin: 0 }}>{e}</p>)}
      </div>
    </Dialog>
  );
}
