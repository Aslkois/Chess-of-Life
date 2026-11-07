import { useEffect, useRef } from 'react';
import type { MoveItem } from './MoveList';
import { ClassIcon } from './ClassIcon';

/** Compact horizontal notation for phones: the current move stays centred. */
export function MoveStrip({ moves, current, onSelect, startPly = 0, showIcons }: { moves: MoveItem[]; current: number; onSelect?: (n: number) => void; startPly?: number; showIcons?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>('.strip-move.is-current');
    if (!box) return;
    if (!el) { box.scrollLeft = 0; return; }
    box.scrollLeft = el.offsetLeft - box.clientWidth / 2 + el.offsetWidth / 2;
  }, [current, moves.length]);
  return (
    <div className="strip" ref={ref} data-testid="movestrip" aria-label="Moves">
      {onSelect && <button type="button" className={`strip-move${current === 0 ? ' is-current' : ''}`} onClick={() => onSelect(0)}>Start</button>}
      {moves.map((m, i) => {
        const ply = startPly + i + 1;
        const white = ply % 2 === 1;
        return (
          <button key={i} type="button" className={`strip-move${current === i + 1 ? ' is-current' : ''}`} onClick={() => onSelect?.(i + 1)} disabled={!onSelect} data-ply={i + 1}>
            {(white || i === 0) && <span className="strip-num">{Math.ceil(ply / 2)}{white ? '.' : '…'}</span>}
            {m.san}
            {showIcons && m.cls && <ClassIcon cls={m.cls} size={14} provisional={m.provisional} />}
          </button>
        );
      })}
    </div>
  );
}
