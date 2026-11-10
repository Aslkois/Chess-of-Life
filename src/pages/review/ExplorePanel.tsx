import { Chess } from 'chess.js';
import { useEffect, useState } from 'react';
import { mainline, pathTo, updateNode, type GameTree } from '../../chess/tree';
import { materialCount } from '../../chess/rules';
import { analyzeMove } from '../../analysis/motifs';
import type { Classification } from '../../analysis/classify';
import { formatScore, winPercentPov, type Score } from '../../engine/score';
import { BranchMap, TreeOutline } from './Tree';
import { IconCpu, IconPlay, IconTrash } from '../../ui/icons';
import { continuations } from '../../analysis/openings';
import { ExplorerMoves } from '../../explorer/ExplorerMoves';

const moveLabel = (ply: number, san: string) => `${Math.ceil(ply / 2)}${ply % 2 ? '.' : '…'} ${san}`;

export function ExplorePanel({ tree, cur, onSelect, classOf, evalOf, onChangeTree, onDelete, branchId, busy, canEngine, onEngineMove, onEngineContinue, onTheory, showTheory, onPlay }: {
  tree: GameTree;
  cur: string;
  onSelect: (id: string) => void;
  classOf: (id: string) => { cls: Classification; provisional: boolean } | undefined;
  evalOf: (id: string) => Score | undefined;
  onChangeTree: (t: GameTree) => void;
  onDelete: (branchId: string) => void;
  branchId: string | null;
  busy: string | null;
  canEngine: boolean;
  onEngineMove: () => void;
  onEngineContinue: (plies: number) => void;
  /** add a catalogued continuation as a theory branch */
  onTheory?: (uci: string) => void;
  showTheory?: boolean;
  /** play a move from the database as a branch */
  onPlay?: (uci: string) => void;
}) {
  const node = tree.nodes[cur];
  const theory = showTheory ? continuations(node.fen).slice(0, 6) : [];
  const existing = new Set(node.children.map((c) => tree.nodes[c].uci));
  return (
    <div data-testid="explore-panel">
      <div className="section" style={{ paddingBottom: 'var(--s-2)' }}>
        <div className="legend" aria-label="Legend">
          <span><i style={{ background: 'var(--ivory)' }} />Played in the game</span>
          <span><i style={{ background: 'var(--branch)' }} />Your branches</span>
          <span><i style={{ background: 'repeating-linear-gradient(90deg, var(--engine) 0 4px, transparent 4px 7px)' }} />Engine lines</span>
          {showTheory && <span><i style={{ background: 'var(--c-book)' }} />Catalogued theory</span>}
        </div>
      </div>
      <BranchMap tree={tree} current={cur} onSelect={onSelect} classOf={classOf} />
      <TreeOutline tree={tree} current={cur} onSelect={onSelect} classOf={classOf} />
      {theory.length > 0 && onTheory && (
        <div className="section" data-testid="theory-branches">
          <h3 className="section-title">Catalogued theory from here</h3>
          <div className="row" style={{ gap: 6 }}>
            {theory.map((c) => <button key={c.uci} type="button" className="btn btn-sm" onClick={() => onTheory(c.uci)} title={c.opening ? c.opening.name : `${c.lines} catalogued line${c.lines === 1 ? '' : 's'}`} data-testid="theory-move">{c.san}{existing.has(c.uci) ? ' ✓' : ''}</button>)}
          </div>
          <p className="xs faint" style={{ marginTop: 'var(--s-2)', marginBottom: 0 }}>Adds the catalogued move as a theory branch. Moves already in the tree are followed instead.</p>
        </div>
      )}
      {onPlay && showTheory && (
        <details className="disclose section" data-testid="review-explorer">
          <summary>Explorer: what others played here</summary>
          <div style={{ marginTop: 'var(--s-2)' }}><ExplorerMoves fen={node.fen} onPlay={onPlay} compact /></div>
        </details>
      )}
      <div className="section">
        <h3 className="section-title">Continue from this position</h3>
        <div className="row">
          <button type="button" className="btn btn-sm" disabled={!!busy || !canEngine} onClick={onEngineMove} data-testid="engine-move" title={canEngine ? 'Add the engine’s best move here' : 'No legal moves here'}><IconCpu size={16} /> Engine move</button>
          <button type="button" className="btn btn-sm" disabled={!!busy || !canEngine} onClick={() => onEngineContinue(6)} data-testid="engine-continue"><IconPlay size={16} /> Stockfish plays 6 moves</button>
        </div>
        <p className="xs faint" style={{ marginTop: 'var(--s-2)', marginBottom: 0 }}>{busy ?? 'Or play any move on the board. Engine lines show strong play, not what a person would necessarily have done.'}</p>
      </div>
      {branchId && <BranchCard tree={tree} nodeId={cur} branchId={branchId} evalOf={evalOf} onChange={onChangeTree} onDelete={() => onDelete(branchId)} onGoto={onSelect} />}
    </div>
  );
}

function BranchCard({ tree, nodeId, branchId, evalOf, onChange, onDelete, onGoto }: {
  tree: GameTree; nodeId: string; branchId: string; evalOf: (id: string) => Score | undefined; onChange: (t: GameTree) => void; onDelete: () => void; onGoto: (id: string) => void;
}) {
  const b = tree.nodes[branchId];
  const [name, setName] = useState(b.branchName ?? '');
  const [note, setNote] = useState(b.branchNote ?? '');
  useEffect(() => { setName(b.branchName ?? ''); setNote(b.branchNote ?? ''); }, [branchId, b.branchName, b.branchNote]);
  const save = (patch: { branchName?: string; branchNote?: string }) => onChange(updateNode(tree, branchId, patch));

  const node = tree.nodes[nodeId];
  const pathIds = pathTo(tree, nodeId);
  const leaveId = pathIds.find((id) => tree.nodes[id].source !== 'historical' && tree.nodes[id].source !== 'root')!;
  const leave = tree.nodes[leaveId];
  const leaveParent = tree.nodes[leave.parentId!];
  const origId = leaveParent.children.find((c) => tree.nodes[c].source === 'historical');
  const orig = origId ? tree.nodes[origId] : null;
  const main = mainline(tree);
  const origAtPly = main.find((id) => tree.nodes[id].ply === node.ply);
  const mover = new Chess(leaveParent.fen).turn();
  const fmtMat = (d: number) => (d === 0 ? 'level' : `${d > 0 ? 'White' : 'Black'} +${Math.abs(d)}`);
  const win = (s?: Score) => (s ? `${winPercentPov(s, mover).toFixed(0)}%` : '…');
  let facts: string[] = [];
  try { facts = analyzeMove(leaveParent.fen, leave.uci!).motifs.filter((m) => m.kind !== 'capture').slice(0, 3).map((m) => m.text); } catch { /* ignore */ }
  const nested = leaveId !== branchId;
  const size = (() => { let n = 0; const st = [branchId]; while (st.length) { const x = st.pop()!; n++; st.push(...tree.nodes[x].children); } return n; })();

  return (
    <div className="section stack" data-testid="branch-panel">
      <div className="row-nowrap">
        <h3 className="section-title" style={{ margin: 0 }}>This branch</h3>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-danger" onClick={onDelete} data-testid="delete-branch"><IconTrash size={16} /> Delete branch</button>
      </div>
      <p className="small dim" style={{ margin: 0 }}>
        {nested ? <>Starts at {moveLabel(b.ply, b.san!)}, inside an earlier exploration. </> : null}
        Left the game at <b>{moveLabel(leave.ply, leave.san!)}</b>
        {orig ? <> instead of <button type="button" className="link-btn" onClick={() => onGoto(orig.id)} title="Go to the move played in the game">{orig.san}</button></> : ' after the game had ended'}. This branch has {size} move{size === 1 ? '' : 's'}.
      </p>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" value={name} placeholder="Name this line, e.g. Keep the knight" onChange={(e) => setName(e.target.value)}
          onBlur={() => save({ branchName: name.trim() || undefined })} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} data-testid="branch-name" maxLength={60} />
      </label>
      <label className="field">
        <span className="field-label">Notes</span>
        <textarea className="textarea" rows={2} value={note} placeholder="What were you testing?" style={{ fontFamily: 'var(--font-ui)', fontSize: 'var(--fs-sm)' }}
          onChange={(e) => setNote(e.target.value)} onBlur={() => save({ branchNote: note.trim() || undefined })} />
      </label>
      <div>
        <h3 className="section-title">Compared with the game</h3>
        <table className="compare" data-testid="branch-compare">
          <thead><tr><th /><th className="branch-col">This line</th><th>Original game</th></tr></thead>
          <tbody>
            <tr><td>Move where they split</td><td className="branch-col">{leave.san}</td><td>{orig ? orig.san : 'game over'}</td></tr>
            <tr><td>{mover === 'w' ? 'White' : 'Black'}'s winning chances after it</td><td className="num">{win(evalOf(leaveId))}</td><td className="num">{orig ? win(evalOf(orig.id)) : '–'}</td></tr>
            <tr><td>At move {Math.ceil(node.ply / 2)}</td><td className="num">{formatScore(evalOf(nodeId))}, {fmtMat(materialCount(node.fen).diff)}</td><td className="num">{origAtPly ? `${formatScore(evalOf(origAtPly))}, ${fmtMat(materialCount(tree.nodes[origAtPly].fen).diff)}` : 'game over'}</td></tr>
          </tbody>
        </table>
      </div>
      {facts.length > 0 && (
        <div>
          <h3 className="section-title">What {leave.san} changes</h3>
          <ul className="move-explain" style={{ marginTop: 0 }}>{facts.map((f, i) => <li key={i}>{f}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
