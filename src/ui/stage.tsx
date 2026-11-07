import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { barFraction, formatScore, winPercent, type Score } from '../engine/score';
import { capturedPieces, materialCount } from '../chess/rules';
import { formatClock } from '../chess/clock';

const STRIP = 44;
const GAP = 8;

/**
 * The board column: player strip, [eval bar] board, player strip. The board
 * is sized to fit both the column width and the viewport height so the whole
 * stage stays visible without scrolling on desktop.
 */
export function Stage({ top, bottom, evalScore, orientation, children, below, reserveBottom = 24 }: {
  top?: ReactNode;
  bottom?: ReactNode;
  /** undefined = no eval bar (e.g. Ranked, Coach) */
  evalScore?: Score | null;
  orientation: 'white' | 'black';
  children: (size: number) => ReactNode;
  below?: ReactNode;
  reserveBottom?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const belowRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(0);
  const withEval = evalScore !== undefined;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const narrow = window.innerWidth <= 760;
      const stacked = window.innerWidth <= 899;
      const evalW = withEval ? (narrow ? 12 : 26) + GAP : 0;
      const availW = el.clientWidth - evalW;
      const topDoc = el.getBoundingClientRect().top + window.scrollY;
      const strips = (top ? STRIP + GAP : 0) + (bottom ? STRIP + GAP : 0);
      const belowH = belowRef.current ? belowRef.current.offsetHeight + GAP : 0;
      const dock = stacked ? 76 : 0;
      const availH = window.innerHeight - Math.min(topDoc, 180) - strips - belowH - reserveBottom - dock;
      let s = Math.min(availW, narrow ? Math.max(availH, 300) : Math.max(availH, 320));
      s = Math.max(240, Math.min(s, 1100));
      setSize(Math.floor(s / 8) * 8);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    window.addEventListener('resize', compute);
    return () => { ro.disconnect(); window.removeEventListener('resize', compute); };
  }, [withEval, !!top, !!bottom, reserveBottom]);
  return (
    <div className="stage" ref={ref}>
      {top}
      <div className="stage-board-row">
        {withEval && <EvalBar score={evalScore ?? undefined} orientation={orientation} height={size} />}
        {size > 0 && children(size)}
      </div>
      {bottom}
      {below && <div ref={belowRef}>{below}</div>}
    </div>
  );
}

export function EvalBar({ score, orientation, height }: { score?: Score; orientation: 'white' | 'black'; height: number }) {
  const f = barFraction(score);
  const text = score ? formatScore(score).replace('+', '') : '';
  const whiteAhead = score ? winPercent(score) >= 50 : true;
  const whiteBottom = orientation === 'white';
  const labelBottom = whiteAhead === whiteBottom;
  return (
    <div className="evalbar" style={{ height }} data-testid="evalbar" role="meter" aria-label="Evaluation" aria-valuetext={score ? `${formatScore(score)} from White's side` : 'not available yet'}>
      <div className="evalbar-white" style={{ height: `${f * 100}%`, ...(whiteBottom ? { bottom: 0 } : { top: 0 }) }} />
      {text && <div className="evalbar-label" style={{ [labelBottom ? 'bottom' : 'top']: 6, color: whiteAhead ? '#1a1c18' : '#e9e5d8' }}>{text}</div>}
    </div>
  );
}

const GLYPH: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };

export function PlayerStrip({ name, color, fen, meta, clockMs, running, isTurn, testId }: {
  name: ReactNode; color: 'w' | 'b'; fen: string; meta?: ReactNode; clockMs?: number; running?: boolean; isTurn?: boolean; testId?: string;
}) {
  const cap = capturedPieces(fen);
  const mine = color === 'w' ? cap.byWhite : cap.byBlack;
  const mat = materialCount(fen);
  const adv = color === 'w' ? mat.diff : -mat.diff;
  return (
    <div className={`player-strip${isTurn ? ' is-turn' : ''}`} data-testid={testId ?? `player-${color}`}>
      <span className="player-dot" style={{ background: color === 'w' ? '#efeadb' : '#191c19' }} aria-label={color === 'w' ? 'White' : 'Black'} />
      <span className="player-name ellipsis">{name}</span>
      {isTurn && clockMs === undefined && <span className="turn-flag">to move</span>}
      {meta && <span className="player-meta">{meta}</span>}
      <span className="captured" aria-label={mine.length ? `captured: ${mine.join(' ')}` : undefined}>{mine.map((p) => GLYPH[p]).join('')}</span>
      {adv > 0 && <span className="material">+{adv}</span>}
      {clockMs !== undefined && isFinite(clockMs) && (
        <span className={`clock${running ? ' is-running' : ''}${clockMs < 20000 ? ' is-low' : ''}`} data-testid={`clock-${color}`} role="timer" aria-label={`${color === 'w' ? 'White' : 'Black'} clock ${formatClock(clockMs)}`}>{formatClock(clockMs)}</span>
      )}
    </div>
  );
}

/** Re-render on an interval (for clocks). */
export function useTick(active: boolean, ms = 200) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [active, ms]);
}
