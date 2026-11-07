import { useEffect, useRef, type ReactNode } from 'react';
import type { Classification } from '../analysis/classify';
import { ClassIcon, PendingIcon } from './ClassIcon';

export interface MoveItem {
  san: string;
  cls?: Classification | null;
  provisional?: boolean;
  /** show a pending marker while the move is being analysed */
  pending?: boolean;
  title?: string;
}

/**
 * Two-column notation (move number, White, Black). `current` is the number of
 * moves applied (0 = start position). The current move is filled ivory and
 * kept in view inside the list without scrolling the page.
 */
export function MoveList({ moves, current, onSelect, futureFrom, startPly = 0, showIcons = false, testId = 'movelist', empty, style }: {
  moves: MoveItem[]; current: number; onSelect?: (n: number) => void; futureFrom?: number; startPly?: number; showIcons?: boolean; testId?: string; empty?: ReactNode; style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>('.ml-cell.is-current');
    if (!box) return;
    if (!el) { if (current === 0) box.scrollTop = 0; return; }
    const top = el.offsetTop - box.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < box.scrollTop + 8) box.scrollTop = Math.max(0, top - 48);
    else if (bottom > box.scrollTop + box.clientHeight - 8) box.scrollTop = bottom - box.clientHeight + 48;
  }, [current, moves.length]);

  const offset = startPly % 2;
  const total = moves.length + offset;
  const rows: JSX.Element[] = [];
  for (let r = 0; r < Math.ceil(total / 2); r++) {
    const cells: JSX.Element[] = [];
    for (let c = 0; c < 2; c++) {
      const idx = r * 2 + c - offset;
      if (idx < 0 || idx >= moves.length) { cells.push(<span key={c} />); continue; }
      const m = moves[idx];
      const cur = idx + 1 === current;
      const future = futureFrom !== undefined && idx >= futureFrom;
      cells.push(
        <button key={c} type="button" className={`ml-cell${cur ? ' is-current' : ''}${future ? ' is-future' : ''}`} onClick={() => onSelect?.(idx + 1)}
          title={m.title} data-ply={idx + 1} aria-current={cur ? 'step' : undefined} disabled={!onSelect}>
          <span>{m.san}</span>
          {showIcons && (m.cls ? <ClassIcon cls={m.cls} size="xs" provisional={m.provisional} /> : m.pending ? <PendingIcon /> : null)}
        </button>,
      );
    }
    rows.push(<div className="ml-row" key={r}><span className="ml-num">{Math.floor(startPly / 2) + r + 1}.</span>{cells}</div>);
  }
  return (
    <div className="movelist" ref={ref} data-testid={testId} style={style} aria-label="Moves">
      {moves.length === 0 ? <div className="ml-empty">{empty ?? 'No moves yet.'}</div> : rows}
    </div>
  );
}
