import { useEffect, useMemo, useRef, useState } from 'react';
import { mainline, pathTo, preferredChild, type GameTree, type TreeNode } from '../../chess/tree';
import { CLASS_INFO, type Classification } from '../../analysis/classify';
import { ClassIcon } from '../../ui/ClassIcon';

type ClassOf = (id: string) => { cls: Classification; provisional: boolean } | undefined;
const SRC_COLOR: Record<string, string> = { historical: '#ede7d5', root: '#ede7d5', user: '#b49cf4', engine: '#8fb2d9', imported: '#d6c48f' };
const NOTABLE: Classification[] = ['brilliant', 'great', 'miss', 'mistake', 'blunder'];

/**
 * Branch map: the original game is the top lane; every branch gets its own
 * lane, drawn from the move where it diverges. The current path is bright.
 */
export function BranchMap({ tree, current, onSelect, classOf }: { tree: GameTree; current: string; onSelect: (id: string) => void; classOf: ClassOf }) {
  const wrap = useRef<HTMLDivElement>(null);
  const onPath = useMemo(() => new Set(pathTo(tree, current)), [tree, current]);
  const layout = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>();
    const root = tree.nodes[tree.rootId];
    let rows = 0;
    const lay = (start: string, row: number) => {
      const chain: string[] = [];
      let cur: string | null = start;
      while (cur) { chain.push(cur); pos.set(cur, { x: tree.nodes[cur].ply - root.ply, y: row }); cur = preferredChild(tree, cur); }
      for (const id of chain) {
        const pref = preferredChild(tree, id);
        for (const alt of tree.nodes[id].children) if (alt !== pref) { rows++; lay(alt, rows); }
      }
    };
    lay(tree.rootId, 0);
    const maxX = Math.max(1, ...[...pos.values()].map((p) => p.x));
    return { pos, rows: rows + 1, maxX, rootPly: root.ply };
  }, [tree]);

  const COL = Math.max(11, Math.min(22, 560 / layout.maxX));
  const ROW = 26;
  const PADX = 16;
  const TOP = 22;
  const W = PADX * 2 + layout.maxX * COL;
  const H = TOP + layout.rows * ROW + 6;
  const px = (x: number) => PADX + x * COL;
  const py = (y: number) => TOP + 10 + y * ROW;

  useEffect(() => {
    const p = layout.pos.get(current);
    const el = wrap.current;
    if (!p || !el) return;
    const x = px(p.x);
    if (x < el.scrollLeft + 40 || x > el.scrollLeft + el.clientWidth - 40) el.scrollLeft = x - el.clientWidth / 2;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, layout]);

  const ticks: JSX.Element[] = [];
  for (let ply = 0; ply <= layout.maxX; ply++) {
    const abs = ply + layout.rootPly;
    if (abs % 10 === 0 && abs > 0) {
      ticks.push(<g key={`t${ply}`}><line x1={px(ply)} x2={px(ply)} y1={TOP - 4} y2={H} stroke="#26312c" strokeWidth={1} /><text x={px(ply)} y={TOP - 8} textAnchor="middle" fontSize="10.5" fill="#737b73">{abs / 2}</text></g>);
    }
  }
  const edges: JSX.Element[] = [];
  const marks: JSX.Element[] = [];
  const hits: JSX.Element[] = [];
  const labels: JSX.Element[] = [];
  for (const [id, p] of layout.pos) {
    const n = tree.nodes[id];
    const color = SRC_COLOR[n.source];
    const lit = onPath.has(id);
    if (n.parentId) {
      const pp = layout.pos.get(n.parentId)!;
      const [x1, y1, x2, y2] = [px(pp.x), py(pp.y), px(p.x), py(p.y)];
      const d = y1 === y2 ? `M${x1},${y1}L${x2},${y2}` : `M${x1},${y1}C${x1 + COL * 0.9},${y1} ${x2 - COL * 0.9},${y2} ${x2},${y2}`;
      edges.push(<path key={`e${id}`} d={d} fill="none" stroke={color} strokeWidth={lit ? 3 : n.source === 'historical' ? 2 : 1.6} strokeOpacity={lit ? 1 : 0.42} strokeDasharray={n.source === 'engine' ? '4 3' : undefined} strokeLinecap="round" />);
      if (y1 !== y2) marks.push(<circle key={`f${id}`} cx={x1} cy={y1} r={3.2} fill="#0e1412" stroke={color} strokeWidth={1.6} />);
    }
    const c = classOf(id);
    if (c && NOTABLE.includes(c.cls)) marks.push(<circle key={`c${id}`} cx={px(p.x)} cy={py(p.y)} r={4.2} fill={CLASS_INFO[c.cls].color} stroke="#0e1412" strokeWidth={1.4} />);
    if (n.branchName) labels.push(<text key={`l${id}`} x={px(p.x) + 8} y={py(p.y) - 7} fontSize="11" fontWeight={650} fill="#b49cf4">{n.branchName}</text>);
    hits.push(
      <circle key={`h${id}`} cx={px(p.x)} cy={py(p.y)} r={Math.max(7, COL / 2)} fill="transparent" style={{ cursor: 'pointer' }} onClick={() => onSelect(id)}>
        <title>{n.san ? `${Math.ceil(n.ply / 2)}${n.ply % 2 ? '.' : '…'} ${n.san}${n.branchName ? `: ${n.branchName}` : ''}` : 'Starting position'}</title>
      </circle>,
    );
  }
  const curP = layout.pos.get(current);
  return (
    <div className="branchmap-wrap" ref={wrap} style={{ maxHeight: 12 * ROW + TOP + 20, overflowY: 'auto' }}>
      <svg className="branchmap" width={W} height={H} data-testid="treemap" role="img" aria-label={`Branch map: the original game and ${layout.rows - 1} explored line${layout.rows === 2 ? '' : 's'}`}>
        {ticks}{edges}{marks}{labels}
        {curP && <circle cx={px(curP.x)} cy={py(curP.y)} r={6.5} fill="#ede7d5" stroke="#0e1412" strokeWidth={2.5} />}
        {hits}
      </svg>
    </div>
  );
}

/**
 * Variation notation. The original game reads left to right; each branch is
 * indented under the move it replaces and can be collapsed.
 */
export function TreeOutline({ tree, current, onSelect, classOf }: { tree: GameTree; current: string; onSelect: (id: string) => void; classOf: ClassOf }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const onPath = useMemo(() => new Set(pathTo(tree, current)), [tree, current]);
  const main = useMemo(() => new Set(mainline(tree)), [tree]);
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const moveBtn = (n: TreeNode, forceNum: boolean) => {
    const white = n.ply % 2 === 1;
    const c = main.has(n.id) ? classOf(n.id) : undefined;
    return (
      <span key={n.id} className="row-nowrap" style={{ gap: 0 }}>
        {(white || forceNum) && <span className="tree-num">{Math.ceil(n.ply / 2)}{white ? '.' : '…'}</span>}
        {n.branchName && <span className="tree-name">{n.branchName}</span>}
        <button type="button" className={`tree-move src-${n.source}${n.id === current ? ' is-current' : ''}`} onClick={() => onSelect(n.id)} data-node={n.id} aria-current={n.id === current ? 'step' : undefined}
          title={n.source === 'historical' ? 'Played in the game' : n.source === 'engine' ? 'Engine continuation' : n.source === 'imported' ? 'Variation from the PGN' : 'Your exploration'}>
          {n.san}
          {c && NOTABLE.includes(c.cls) && <ClassIcon cls={c.cls} size={14} provisional={c.provisional} />}
        </button>
      </span>
    );
  };

  const chain = (parentId: string, first: string | null): JSX.Element[] => {
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
        out.push(<div className="tree-line" key={`r${child.id}`}>{run}</div>);
        run = [];
        for (const a of alts) {
          const an = tree.nodes[a];
          const isCol = collapsed.has(a);
          out.push(
            <div className={`tree-var src-${an.source}${onPath.has(a) ? ' is-active' : ''}`} key={`v${a}`}>
              <button type="button" className="tree-toggle" onClick={() => toggle(a)} aria-expanded={!isCol} aria-label={isCol ? `Show branch ${an.branchName ?? an.san}` : `Hide branch ${an.branchName ?? an.san}`}>
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d={isCol ? 'M3 2l4 3-4 3' : 'M2 3l3 4 3-4'} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
              {isCol ? <div className="tree-collapsed">{an.branchName ?? `${Math.ceil(an.ply / 2)}${an.ply % 2 ? '.' : '…'} ${an.san}`}, {countLine(tree, a)} move{countLine(tree, a) === 1 ? '' : 's'} hidden{onPath.has(a) ? ' (you are here)' : ''}</div> : chain(parent.id, a)}
            </div>,
          );
        }
        forceNum = true;
      }
      isFirst = false;
      parent = child;
      childId = preferredChild(tree, child.id);
    }
    if (run.length) out.push(<div className="tree-line" key={`end${parentId}${first ?? ''}`}>{run}</div>);
    return out;
  };

  return (
    <div className="tree" data-testid="tree">
      {tree.nodes[tree.rootId].children.length === 0 ? <span className="faint">No moves.</span> : chain(tree.rootId, null)}
    </div>
  );
}

function countLine(tree: GameTree, id: string): number {
  let n = 0;
  const stack = [id];
  while (stack.length) { const x = stack.pop()!; n++; stack.push(...tree.nodes[x].children); }
  return n;
}
