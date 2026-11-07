import { useMemo, useState } from 'react';
import { pathTo, preferredChild, type GameTree, type TreeNode } from '../chess/tree';
import type { Classification } from '../analysis/classify';
import { ClassBadge } from './bits';

interface Props {
  tree: GameTree;
  current: string;
  onSelect: (id: string) => void;
  classOf?: (id: string) => { cls: Classification; provisional: boolean } | undefined;
}

const SRC_LABEL: Record<string, string> = { user: 'explored', engine: 'engine line', imported: 'from PGN' };

/**
 * Navigable variation tree in two synchronised views: an outline (PGN-style,
 * collapsible) and a branch map where every line of play is a lane.
 */
export function TreeView({ tree, current, onSelect, classOf }: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const onPath = useMemo(() => new Set(pathTo(tree, current)), [tree, current]);
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const moveBtn = (n: TreeNode, forceNum: boolean) => {
    const white = n.ply % 2 === 1;
    const num = Math.ceil(n.ply / 2);
    const c = classOf?.(n.id);
    return (
      <span key={n.id} style={{ display: 'inline-flex', alignItems: 'center' }}>
        {(white || forceNum) && <span className="n">{num}{white ? '.' : '…'}</span>}
        {n.branchName && <span className="bname">{n.branchName}</span>}
        <button className={`tm ${n.source}${n.id === current ? ' cur' : ''}`} onClick={() => onSelect(n.id)} data-node={n.id} title={n.source !== 'historical' ? SRC_LABEL[n.source] : 'played in the game'}>
          {n.san}
        </button>
        {c && <ClassBadge cls={c.cls} provisional={c.provisional} />}
      </span>
    );
  };

  const chain = (parentId: string, first: string | null, depth: number): JSX.Element[] => {
    const out: JSX.Element[] = [];
    let run: JSX.Element[] = [];
    let parent = tree.nodes[parentId];
    let childId: string | null = first ?? preferredChild(tree, parentId);
    let forceNum = true;
    let isFirst = true;
    while (childId) {
      const child = tree.nodes[childId];
      run.push(moveBtn(child, forceNum));
      forceNum = false;
      const alts = isFirst && first ? [] : parent.children.filter((c) => c !== childId);
      if (alts.length) {
        out.push(<div className="line" key={`r${child.id}`}>{run}</div>);
        run = [];
        for (const a of alts) {
          const an = tree.nodes[a];
          const isCol = collapsed.has(a);
          out.push(
            <div className={`var ${an.source}`} key={`v${a}`}>
              <button className="toggle" onClick={() => toggle(a)} aria-label={isCol ? 'expand variation' : 'collapse variation'}>{isCol ? '▸' : '▾'}</button>
              {isCol ? (
                <span className="faint small">{an.branchName ?? `${an.san}…`} ({countLine(tree, a)} moves){onPath.has(a) ? ' • current' : ''}</span>
              ) : (
                chain(parent.id, a, depth + 1)
              )}
            </div>,
          );
        }
        forceNum = true;
      }
      isFirst = false;
      parent = child;
      childId = preferredChild(tree, child.id);
    }
    if (run.length) out.push(<div className="line" key={`end${parentId}${first ?? ''}`}>{run}</div>);
    return out;
  };

  return (
    <div>
      <TreeMap tree={tree} current={current} onSelect={onSelect} onPath={onPath} />
      <div className="tree" data-testid="tree">
        {tree.nodes[tree.rootId].children.length === 0 ? <span className="faint">No moves.</span> : chain(tree.rootId, null, 0)}
      </div>
    </div>
  );
}

function countLine(tree: GameTree, id: string): number {
  let n = 0;
  const stack = [id];
  while (stack.length) { const x = stack.pop()!; n++; stack.push(...tree.nodes[x].children); }
  return n;
}

/** Branch map: each line of play is a lane; x = move number. */
function TreeMap({ tree, current, onSelect, onPath }: { tree: GameTree; current: string; onSelect: (id: string) => void; onPath: Set<string> }) {
  const layout = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    let rows = 0;
    const root = tree.nodes[tree.rootId];
    const lay = (start: string, row: number) => {
      const chainIds: string[] = [];
      let cur: string | null = start;
      while (cur) { chainIds.push(cur); pos.set(cur, { x: tree.nodes[cur].ply - root.ply, y: row }); cur = preferredChild(tree, cur); }
      for (const id of chainIds) {
        const pref = preferredChild(tree, id);
        for (const alt of tree.nodes[id].children) if (alt !== pref) { rows++; lay(alt, rows); }
      }
    };
    lay(tree.rootId, 0);
    const maxX = Math.max(1, ...[...pos.values()].map((p) => p.x));
    return { pos, rows: rows + 1, maxX };
  }, [tree]);
  if (layout.rows <= 1 && layout.maxX < 2) return null;
  const COL = Math.max(6, Math.min(14, 560 / layout.maxX));
  const ROW = 16;
  const W = layout.maxX * COL + 20;
  const H = Math.min(layout.rows, 30) * ROW + 12;
  const lines: JSX.Element[] = [];
  const dots: JSX.Element[] = [];
  for (const [id, p] of layout.pos) {
    if (p.y >= 30) continue;
    const n = tree.nodes[id];
    const cx = 10 + p.x * COL;
    const cy = 8 + p.y * ROW;
    const color = n.source === 'historical' || n.source === 'root' ? '#dfe3dc' : n.source === 'engine' ? '#a48ad6' : n.source === 'imported' ? '#cfc79e' : '#4fb6b0';
    if (n.parentId) {
      const pp = layout.pos.get(n.parentId)!;
      const px = 10 + pp.x * COL;
      const py = 8 + pp.y * ROW;
      lines.push(<path key={`l${id}`} d={py === cy ? `M${px},${py}L${cx},${cy}` : `M${px},${py}C${px + COL / 2},${py} ${px},${cy} ${cx},${cy}`} stroke={onPath.has(id) ? '#8fc17a' : color} strokeOpacity={onPath.has(id) ? 1 : 0.45} strokeWidth={onPath.has(id) ? 2 : 1.2} fill="none" />);
    }
    dots.push(
      <circle key={`d${id}`} cx={cx} cy={cy} r={id === current ? 4.5 : n.branchName ? 3.5 : 2.2} fill={id === current ? '#8fc17a' : color} stroke={n.branchName ? '#4fb6b0' : 'none'} style={{ cursor: 'pointer' }} onClick={() => onSelect(id)}>
        <title>{n.san ? `${Math.ceil(n.ply / 2)}${n.ply % 2 ? '.' : '…'} ${n.san}${n.branchName ? ` — ${n.branchName}` : ''}` : 'Start'}</title>
      </circle>,
    );
  }
  return (
    <div style={{ overflowX: 'auto', marginBottom: 8, borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>
      <svg className="tree-map" width={W} height={H} style={{ minWidth: Math.min(W, 300) }} data-testid="treemap" aria-label="Branch map">{lines}{dots}</svg>
      {layout.rows > 30 && <div className="faint small">Showing the first 30 lines of {layout.rows}.</div>}
    </div>
  );
}
