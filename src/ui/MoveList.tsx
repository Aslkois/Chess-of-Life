import { useEffect, useRef } from 'react';
import type { Classification } from '../analysis/classify';
import { ClassBadge } from './bits';

export interface MoveItem {
  san: string;
  cls?: Classification | null;
  provisional?: boolean;
  showBadge?: boolean;
  title?: string;
}

/**
 * Linear move list. `current` is the number of moves applied (0 = start).
 * Moves at index >= `futureFrom` are shown dimmed (redo history).
 */
export function MoveList({ moves, current, onSelect, futureFrom, startPly = 0, testId = 'movelist' }: { moves: MoveItem[]; current: number; onSelect?: (n: number) => void; futureFrom?: number; startPly?: number; testId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector('.mv.cur') as HTMLElement | null;
    if (el && ref.current) {
      const top = el.offsetTop - ref.current.offsetTop;
      if (top < ref.current.scrollTop || top > ref.current.scrollTop + ref.current.clientHeight - 30) ref.current.scrollTop = top - 60;
    }
  }, [current, moves.length]);
  const rows: JSX.Element[] = [];
  const offset = startPly % 2; // 1 if black moved first
  const total = moves.length + offset;
  for (let r = 0; r < Math.ceil(total / 2); r++) {
    const num = Math.floor(startPly / 2) + r + 1;
    rows.push(<span className="num" key={`n${r}`}>{num}.</span>);
    for (let c = 0; c < 2; c++) {
      const idx = r * 2 + c - offset;
      if (idx < 0 || idx >= moves.length) { rows.push(<span key={`e${r}${c}`} />); continue; }
      const m = moves[idx];
      const cls = ['mv', idx + 1 === current ? 'cur' : '', futureFrom !== undefined && idx >= futureFrom ? 'future' : ''].join(' ');
      rows.push(
        <button key={`m${idx}`} className={cls} onClick={() => onSelect?.(idx + 1)} title={m.title} data-ply={idx + 1}>
          <span>{m.san}</span>
          {m.showBadge && <ClassBadge cls={m.cls} provisional={m.provisional} />}
        </button>,
      );
    }
  }
  return (
    <div className="moves" ref={ref} data-testid={testId}>
      {moves.length === 0 ? <span className="faint small" style={{ gridColumn: '1 / -1', padding: 6 }}>No moves yet.</span> : rows}
    </div>
  );
}
