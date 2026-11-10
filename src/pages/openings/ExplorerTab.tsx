import { Chess } from 'chess.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Board, PlanToggle, type BoardMove } from '../../ui/Board';
import { PlayerStrip, Stage } from '../../ui/stage';
import { ReplayControls } from '../../ui/Replay';
import { Dialog } from '../../ui/Dialog';
import { downloadText } from '../../ui/bits';
import { IconCpu, IconDownload, IconFlip, IconReview, IconStar, IconUpload } from '../../ui/icons';
import { useApp } from '../../ui/context';
import { useKeys } from '../../ui/useKeys';
import { navigate } from '../../ui/router';
import { trackOpening } from '../../analysis/openings';
import { formatLine, pvToSan } from '../../analysis/explain';
import { addMove, createTree, mainline, pathTo, preferredChild, START_FEN, type GameTree } from '../../chess/tree';
import { exportPgn, parsePgn } from '../../chess/pgn';
import { positionKey } from '../../chess/positionKey';
import { get } from '../../db/db';
import { gameFromMoves, gameFromParsed, saveGame } from '../../services/games';
import { addLine } from '../../services/repertoire';
import { getEngine } from '../../engine/instance';
import type { AnalysisResult } from '../../engine/controller';
import { formatScore } from '../../engine/score';
import { ExplorerMoves } from '../../explorer/ExplorerMoves';
import { ExplorerError, fetchGamePgn } from '../../explorer/lichess';
import type { ExGame } from '../../explorer/types';
import { TreeOutline } from '../review/Tree';
import { OpeningHeader } from './OpeningHeader';
import { parsePathParam, pathParam } from './paths';

type Pane = 'database' | 'engine' | 'tree';
const moveNo = (ply: number) => `${Math.floor(ply / 2) + 1}${ply % 2 === 0 ? '.' : '...'}`;

/** Build an exploration tree from a start FEN and a list of UCI moves. */
function treeFrom(startFen: string, ucis: string[]): { tree: GameTree; cur: string } {
  let tree = createTree(startFen);
  let cur = tree.rootId;
  for (const u of ucis) {
    try { const r = addMove(tree, cur, { from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }, 'user'); tree = r.tree; cur = r.nodeId; } catch { break; }
  }
  return { tree, cur };
}

export function ExplorerTab({ pathArg, fenArg }: { pathArg: string; fenArg?: string }) {
  const { prefs, toast } = useApp();
  const init = useMemo(() => {
    let start = START_FEN;
    if (fenArg) { try { start = new Chess(fenArg).fen(); } catch { start = START_FEN; } }
    return treeFrom(start, parsePathParam(pathArg));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const [tree, setTree] = useState<GameTree>(init.tree);
  const [cur, setCur] = useState(init.cur);
  const [orientation, setOrientation] = useState<'white' | 'black'>('white');
  const [pane, setPane] = useState<Pane>('database');
  const [dialog, setDialog] = useState<'fen' | 'pgn' | 'save' | null>(null);
  const [engine, setEngine] = useState<{ fen: string; r: AnalysisResult | null; busy: boolean; error?: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const node = tree.nodes[cur] ?? tree.nodes[tree.rootId];
  const fen = node.fen;
  const rootFen = tree.nodes[tree.rootId].fen;
  const path = useMemo(() => pathTo(tree, node.id), [tree, node.id]);
  const ucis = path.slice(1).map((id) => tree.nodes[id].uci!);
  const sans = path.slice(1).map((id) => tree.nodes[id].san!);
  const track = useMemo(() => trackOpening(path.map((id) => tree.nodes[id].fen)), [tree, path]);
  const ply = track.plies[track.plies.length - 1];
  const leftWith = !ply.inBook && ply.lastBookIndex >= 0 && ply.lastBookIndex < path.length - 1 ? `${moveNo(tree.nodes[path[ply.lastBookIndex + 1]].ply - 1)}${tree.nodes[path[ply.lastBookIndex + 1]].san}` : null;

  // the address follows the position (without navigating)
  useEffect(() => {
    const f = rootFen === START_FEN ? '' : `/${encodeURIComponent(rootFen)}`;
    try { history.replaceState(null, '', `#/openings/explore/${pathParam(ucis) || '-'}${f}`); } catch { /* ignore */ }
  }, [cur, tree]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (engine && engine.fen !== fen) { abort.current?.abort(); setEngine(null); } }, [fen]); // eslint-disable-line react-hooks/exhaustive-deps

  const play = (uci: string) => {
    try {
      const r = addMove(tree, cur, { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }, 'user');
      if (!r.existed) setTree(r.tree);
      setCur(r.nodeId);
    } catch { /* not legal here */ }
  };
  const onMove = (m: BoardMove) => { try { const mv = new Chess(fen).move(m); play(mv.from + mv.to + (mv.promotion ?? '')); return true; } catch { return false; } };
  const prev = () => { if (node.parentId) setCur(node.parentId); };
  const next = () => { const c = preferredChild(tree, cur); if (c) setCur(c); };
  const last = () => { let c = cur; for (;;) { const n = preferredChild(tree, c); if (!n) break; c = n; } setCur(c); };
  const reset = (t: GameTree, at?: string) => { setTree(t); setCur(at ?? t.rootId); };

  const analyse = async () => {
    abort.current?.abort();
    const ac = new AbortController(); abort.current = ac;
    setEngine({ fen, r: null, busy: true });
    try { const r = await getEngine().analyze({ fen, depth: prefs.deepDepth, multipv: 3, priority: 2, signal: ac.signal }); if (!ac.signal.aborted) setEngine({ fen, r, busy: false }); }
    catch (e) { if (!ac.signal.aborted) setEngine({ fen, r: null, busy: false, error: (e as Error).message }); }
  };

  // games from the database: load them here, or open/import them in Game Review
  const openGame = async (g: ExGame, action: 'review' | 'load') => {
    try {
      if (g.source === 'local') {
        if (action === 'review') { navigate(`review/${g.id}/${g.ply ?? 0}`); return; }
        const rec = await get('games', g.id);
        if (!rec) return;
        reset(rec.tree, mainline(rec.tree)[g.ply ?? 0]);
        return;
      }
      const pgn = await fetchGamePgn(g);
      const parsed = parsePgn(pgn).games[0];
      if (!parsed || parsed.errors.length) { toast('That game could not be read.'); return; }
      const key = positionKey(fen);
      const line = mainline(parsed.tree);
      const at = line.findIndex((id) => positionKey(parsed.tree.nodes[id].fen) === key);
      if (action === 'load') { reset(parsed.tree, line[Math.max(0, at)]); return; }
      const rec = { ...gameFromParsed(parsed), playerColor: null as null };
      await saveGame(rec);
      toast('Game imported into your library.');
      navigate(`review/${rec.id}/${Math.max(0, at)}`);
    } catch (e) { toast(e instanceof ExplorerError ? e.message : 'The game could not be loaded.'); }
  };

  const addToAnalysis = async () => {
    const rec = { ...gameFromMoves('manual', sans, { Event: 'Explorer line', White: '?', Black: '?', Result: '*', Date: '????.??.??' }, '*', rootFen), playerColor: null as null };
    await saveGame(rec);
    navigate(`review/${rec.id}/${sans.length}`);
  };
  const exportLine = () => downloadText('explorer.pgn', exportPgn({ Event: 'Chess of Life Explorer', Site: 'Chess of Life', Result: '*' }, tree, '*'), 'application/x-chess-pgn');

  useKeys({
    ArrowLeft: prev, ArrowRight: next, Home: () => setCur(tree.rootId), End: last,
    f: () => setOrientation((o) => (o === 'white' ? 'black' : 'white')),
  });

  const turn = new Chess(fen).turn();
  const top = orientation === 'white' ? 'b' : 'w';
  const lastMove: [string, string] | null = node.uci ? [node.uci.slice(0, 2), node.uci.slice(2, 4)] : null;
  const branches = Object.keys(tree.nodes).length - 1;
  return (
    <div className="board-layout">
      <Stage orientation={orientation}
        top={<PlayerStrip name={top === 'w' ? 'White' : 'Black'} color={top} fen={fen} isTurn={turn === top} />}
        bottom={<PlayerStrip name={top === 'w' ? 'Black' : 'White'} color={top === 'w' ? 'b' : 'w'} fen={fen} isTurn={turn !== top} />}
        below={<div className="row board-tools">
          <button type="button" className="btn btn-sm btn-quiet" onClick={() => setOrientation(orientation === 'white' ? 'black' : 'white')} title="Flip board (F)" data-testid="xp-flip"><IconFlip size={16} /> Flip</button>
          <PlanToggle />
          <span className="spacer" />
          <ReplayControls atStart={!node.parentId} atEnd={!preferredChild(tree, cur)} onFirst={() => setCur(tree.rootId)} onPrev={prev} onNext={next} onLast={last} />
        </div>}>
        {(size) => <Board fen={fen} orientation={orientation} size={size} movable="both" onMove={onMove} lastMove={lastMove} frame="explore" id="explorer-board" />}
      </Stage>
      <div className="panel-slot">
        <section className="panel" aria-label="Explorer" data-testid="opening-explorer">
          <div className="section" style={{ paddingBottom: 'var(--s-2)' }}>
            <OpeningHeader ply={ply} leftWith={leftWith} />
            <div className="xs dim xp-line" data-testid="xp-line">{sans.length ? formatLine(rootFen, sans) : rootFen === START_FEN ? 'Starting position' : 'Position from FEN'}</div>
          </div>
          <div className="panel-tabs" role="tablist">
            <button type="button" role="tab" className="panel-tab" aria-selected={pane === 'database'} onClick={() => setPane('database')} data-testid="pane-database">Database</button>
            <button type="button" role="tab" className="panel-tab" aria-selected={pane === 'engine'} onClick={() => setPane('engine')} data-testid="pane-engine"><IconCpu size={16} />Engine</button>
            <button type="button" role="tab" className="panel-tab" aria-selected={pane === 'tree'} onClick={() => setPane('tree')} data-testid="pane-tree">Moves <span className="count">{branches || ''}</span></button>
          </div>
          <div className="panel-body">
            {pane === 'database' && <div className="section"><ExplorerMoves fen={fen} onPlay={play} onGame={(g, a) => void openGame(g, a)} /></div>}
            {pane === 'engine' && (
              <div className="section" data-testid="engine-pane">
                {!engine && <><p className="small dim" style={{ marginTop: 0 }}>The engine is not consulted until you ask. Its view of a move is independent of how often the move is played.</p><button type="button" className="btn btn-sm" onClick={analyse} data-testid="analyse-position" disabled={new Chess(fen).isGameOver()}><IconCpu size={16} /> Analyse this position</button></>}
                {engine?.busy && <p className="small dim">Analysing to depth {prefs.deepDepth}…</p>}
                {engine?.error && <p className="small">The engine could not analyse this position: {engine.error}</p>}
                {engine?.r && (
                  <ol className="engine-lines" data-testid="engine-lines-explorer">
                    {engine.r.lines.map((l) => (
                      <li key={l.multipv}><button type="button" className="link-btn" onClick={() => l.pv[0] && play(l.pv[0])}><b className="num">{formatScore(l.score)}</b></button> <span className="small">{formatLine(fen, pvToSan(fen, l.pv, 8))}</span></li>
                    ))}
                    <li className="xs faint">Depth {engine.r.depth}. Evaluations are from White’s point of view.</li>
                  </ol>
                )}
              </div>
            )}
            {pane === 'tree' && (
              <div className="section" data-testid="xp-tree">
                {branches ? <TreeOutline tree={tree} current={cur} onSelect={setCur} classOf={() => undefined} /> : <p className="small dim" style={{ margin: 0 }}>Play moves on the board or pick them from the database. Every alternative you try is kept as a branch.</p>}
              </div>
            )}
          </div>
          <div className="panel-foot">
            <div className="row" style={{ gap: 6 }}>
              <button type="button" className="btn btn-sm" onClick={() => setDialog('fen')} data-testid="xp-fen">FEN</button>
              <button type="button" className="btn btn-sm" onClick={() => setDialog('pgn')} data-testid="xp-pgn"><IconUpload size={14} /> PGN</button>
              <button type="button" className="btn btn-sm" onClick={exportLine} disabled={!branches} data-testid="xp-export"><IconDownload size={14} /> Export</button>
              <button type="button" className="btn btn-sm" onClick={() => void addToAnalysis()} disabled={!sans.length} title="Open this line in Game Review for a full analysis" data-testid="xp-analyse"><IconReview size={14} /> Analyse line</button>
              <button type="button" className="btn btn-sm" onClick={() => setDialog('save')} disabled={!sans.length || rootFen !== START_FEN} data-testid="add-to-repertoire"><IconStar size={14} /> Repertoire</button>
              <button type="button" className="btn btn-sm btn-quiet" onClick={() => reset(createTree())} disabled={!branches && rootFen === START_FEN} data-testid="xp-new">New</button>
            </div>
          </div>
        </section>
      </div>
      <FenDialog open={dialog === 'fen'} current={fen} onClose={() => setDialog(null)} onLoad={(f) => { reset(createTree(f)); setDialog(null); }} />
      <PgnDialog open={dialog === 'pgn'} onClose={() => setDialog(null)} onLoad={(t) => { reset(t); setDialog(null); }} />
      <SaveLineDialog open={dialog === 'save'} onClose={() => setDialog(null)} defaultName={ply.opening?.name ?? (sans.join(' ') || 'New line')} defaultColor={defaultSide(ply.opening?.family, sans.length % 2 === 1 ? 'w' : 'b')} sans={sans}
        onSave={async (name, color) => { await addLine(name, color, ucis); setDialog(null); toast(`Saved “${name}” to your ${color === 'w' ? 'White' : 'Black'} repertoire.`); }} />
    </div>
  );
}

/** A sensible default side for a new repertoire line (the user can change it). */
function defaultSide(family: string | undefined, lastMover: 'w' | 'b'): 'w' | 'b' {
  if (family && /Defen[cs]e|Declined|Accepted|Countergambit|Counter-Gambit/.test(family)) return 'b';
  if (family && /Opening|Game|Attack|Gambit|System/.test(family)) return 'w';
  return lastMover;
}

function FenDialog({ open, current, onClose, onLoad }: { open: boolean; current: string; onClose: () => void; onLoad: (fen: string) => void }) {
  const [text, setText] = useState(current);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setText(current); setErr(null); } }, [open, current]);
  const load = () => { try { onLoad(new Chess(text.trim()).fen()); } catch (e) { setErr(`Not a valid position: ${(e as Error).message}`); } };
  return (
    <Dialog open={open} onClose={onClose} title="Position from FEN" description="Explore any position. The current exploration is replaced."
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={load} data-testid="xp-fen-load">Load position</button></>}>
      <div className="stack">
        <input className="input" value={text} onChange={(e) => { setText(e.target.value); setErr(null); }} aria-label="FEN" data-testid="xp-fen-input" data-autofocus />
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => { void navigator.clipboard?.writeText(current); }}>Copy the current FEN</button>
        {err && <p className="xs" role="alert" style={{ margin: 0 }}>{err}</p>}
      </div>
    </Dialog>
  );
}

function PgnDialog({ open, onClose, onLoad }: { open: boolean; onClose: () => void; onLoad: (t: GameTree) => void }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const load = () => {
    const r = parsePgn(text);
    const g = r.games[0];
    if (!g) { setErr(r.errors[0] ?? 'No game found.'); return; }
    if (g.errors.length) { setErr(g.errors[0]); return; }
    onLoad(g.tree);
    setText('');
  };
  return (
    <Dialog open={open} onClose={onClose} title="Explore a PGN" description="The game and its variations are loaded into the Explorer. Nothing is saved to your library." wide
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={load} disabled={!text.trim()} data-testid="xp-pgn-load">Load</button></>}>
      <div className="stack">
        <textarea className="textarea" rows={8} value={text} onChange={(e) => { setText(e.target.value); setErr(null); }} placeholder="1. e4 e5 2. Nf3 (2. Bc4) Nc6 *" data-testid="xp-pgn-input" data-autofocus />
        {err && <p className="xs" role="alert" style={{ margin: 0 }}>{err}</p>}
      </div>
    </Dialog>
  );
}

function SaveLineDialog({ open, onClose, defaultName, defaultColor, sans, onSave }: { open: boolean; onClose: () => void; defaultName: string; defaultColor: 'w' | 'b'; sans: string[]; onSave: (name: string, color: 'w' | 'b') => void }) {
  const [name, setName] = useState(defaultName);
  const [color, setColor] = useState<'w' | 'b'>(defaultColor);
  useEffect(() => { if (open) { setName(defaultName); setColor(defaultColor); } }, [open, defaultName, defaultColor]);
  return (
    <Dialog open={open} onClose={onClose} title="Add this line to your repertoire" description={formatLine(START_FEN, sans)} testId="save-line"
      footer={<><button type="button" className="btn" onClick={onClose}>Cancel</button><button type="button" className="btn btn-primary" onClick={() => onSave(name, color)} data-testid="save-line-confirm">Save line</button></>}>
      <div className="stack">
        <label className="field"><span className="field-label">Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus /></label>
        <div className="field">
          <span className="field-label">You play</span>
          <div className="seg" role="group" aria-label="Your side in this line">
            <button type="button" aria-pressed={color === 'w'} onClick={() => setColor('w')}>White</button>
            <button type="button" aria-pressed={color === 'b'} onClick={() => setColor('b')}>Black</button>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
