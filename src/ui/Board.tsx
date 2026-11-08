import { Chess, type Square } from 'chess.js';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { Chessboard } from 'react-chessboard';
import { CLASS_INFO, type Classification } from '../analysis/classify';
import { useApp } from './context';
import { ClassIcon } from './ClassIcon';
import { prefersReducedMotion } from './useKeys';
import { playSound, transitionSound } from '../audio/sounds';
import { EMPTY_ANNOTATIONS, hasAnnotations, planColor, PLAN_COLORS, setPlanMode, squareAt, toggleArrow, toggleMark, usePlanMode, type Annotations } from './planning';
import { boardAfterPremoves, premoveTargets, type Premove } from '../chess/premove';
import { IconPencil } from './icons';

export interface BoardMove { from: string; to: string; promotion?: string }

/** Review-only: the classification of the move that led to this position. */
export interface BoardAnnotation {
  from: string;
  to: string;
  cls: Classification;
  provisional: boolean;
  /** identity of the annotated move; a new key replays the entrance */
  key: string;
  /** 'animate' after a deliberate step, 'quick' during rapid replay, 'static' for data refreshes */
  mode: 'animate' | 'quick' | 'static';
}

export interface BoardProps {
  fen: string;
  orientation: 'white' | 'black';
  size: number;
  /** which side's pieces the user may move */
  movable: 'w' | 'b' | 'both' | 'none';
  onMove?: (m: BoardMove) => boolean | void;
  lastMove?: [string, string] | null;
  annotation?: BoardAnnotation | null;
  /** arrows: [from, to, color] */
  arrows?: [string, string, string][];
  /** teaching highlights: [square, color] */
  highlights?: [string, string][];
  frame?: 'normal' | 'explore' | 'predict' | 'demo';
  id?: string;
  /** play move sounds when `fen` changes (default true) */
  sound?: boolean;
  /** allow right-click planning annotations (default: the user's setting) */
  planning?: boolean;
  /**
   * Premoves for `color` while it is the other side's turn. `onAdd` returns
   * whether the premove was accepted.
   */
  premove?: { color: 'w' | 'b'; queue: Premove[]; onAdd: (m: Premove) => boolean; onCancel: () => void } | null;
}

/** Colour of queued premoves: distinct from the last move (yellow) and planning arrows (orange). */
export const PREMOVE_COLOR = '#a970d8';

/** Teaching colours (Game Review convention): threats red, better green, idea orange, plans blue. */
export const TONE_COLOR = { threat: '#e5443a', better: '#62b03c', concept: '#f09b48', plan: '#4f8ef0' } as const;

export const BOARD_THEMES = {
  walnut: { label: 'Walnut', light: '#e2cfa7', dark: '#a27a55' },
  moss: { label: 'Moss', light: '#cdd3c2', dark: '#6d8767' },
  slate: { label: 'Slate', light: '#c6ccd2', dark: '#64788a' },
  sand: { label: 'Sand', light: '#ebe2cc', dark: '#b39669' },
} as const;
export type BoardTheme = keyof typeof BOARD_THEMES;

const PROMO = [['q', 'Queen', '♛'], ['r', 'Rook', '♜'], ['b', 'Bishop', '♝'], ['n', 'Knight', '♞']] as const;
const PIECE_MS = 170;

function squareXY(sq: string, orientation: 'white' | 'black') {
  const file = sq.charCodeAt(0) - 97;
  const rank = parseInt(sq[1], 10) - 1;
  return orientation === 'white' ? { col: file, row: 7 - rank } : { col: 7 - file, row: rank };
}

/**
 * Interactive board: drag-and-drop and click-to-move with legality from
 * chess.js, our own promotion picker, check and last-move highlights. In
 * review it shows the played move's classification on the destination
 * square. It never shows assistance on its own; callers decide.
 */
export function Board({ fen, orientation, size, movable, onMove, lastMove, annotation, arrows, highlights, frame = 'normal', id = 'board', sound = true, planning, premove }: BoardProps) {
  const { prefs } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);
  const [annos, setAnnos] = useState<Annotations>(EMPTY_ANNOTATIONS);
  const [planStart, setPlanStart] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ from: string; to: string; color: string } | null>(null);
  const draw = useRef<{ from: string; color: string } | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const planOn = (planning ?? true) && prefs.planning;
  const planMode = usePlanMode() && planOn;

  // a new position: clear the selection and the user's annotations, and play the move's sound
  const prevFen = useRef(fen);
  useEffect(() => {
    const prev = prevFen.current;
    prevFen.current = fen;
    setSelected(null); setPromo(null); setPlanStart(null);
    if (prev !== fen) setAnnos(EMPTY_ANNOTATIONS);
    if (!sound || !prefs.sound) return;
    const t = transitionSound(prev, fen);
    if (t) playSound(t.kind, prefs.soundVolume * (t.direction === 'back' ? 0.55 : 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fen]);

  const chess = useMemo(() => { try { return new Chess(fen); } catch { return new Chess(); } }, [fen]);
  const turn = chess.turn();
  const over = chess.isGameOver();
  const interactive = movable !== 'none' && (movable === 'both' || movable === turn) && !over;
  const premoveMode = !!premove && !over && turn !== premove.color;
  const legalFrom = (sq: string) => chess.moves({ square: sq as Square, verbose: true });
  const reduced = prefersReducedMotion();
  const pre = useMemo(() => (premove ? boardAfterPremoves(fen, premove.queue, premove.color) : null), [fen, premove]);
  const premoveFrom = (sq: string) => (premove && pre ? premoveTargets(pre.board, sq, premove.color, pre.castling) : []);
  const ownForPremove = (sq: string) => { if (!premove || !pre) return false; const i = (sq.charCodeAt(0) - 97) + (Number(sq[1]) - 1) * 8; return pre.board[i]?.c === premove.color; };

  const tryMove = (from: string, to: string, promotion?: string): boolean => {
    if (premoveMode) {
      premove!.onAdd({ from, to, promotion });
      setSelected(null);
      return false; // the premove is shown, not played
    }
    if (!interactive) return false;
    const legal = legalFrom(from).filter((m) => m.to === to);
    if (!legal.length) return false;
    if (legal.some((m) => m.promotion) && !promotion) { setPromo({ from, to }); return false; }
    const ok = onMove?.({ from, to, promotion });
    setSelected(null);
    return ok !== false;
  };

  const planTap = (sq: string) => {
    if (!planStart) { setPlanStart(sq); return; }
    const color = PLAN_COLORS.orange;
    setAnnos((a) => (planStart === sq ? toggleMark(a, sq, color) : toggleArrow(a, planStart, sq, color)));
    setPlanStart(null);
  };

  const onSquareClick = (sq: string) => {
    if (planMode) { planTap(sq); return; }
    if (premoveMode) {
      if (selected && selected !== sq && premoveFrom(selected).includes(sq)) { tryMove(selected, sq); return; }
      setSelected(selected === sq || !ownForPremove(sq) ? null : sq);
      return;
    }
    if (!interactive) return;
    const piece = chess.get(sq as Square);
    if (selected) {
      if (selected === sq) { setSelected(null); return; }
      if (piece && piece.color === turn) { setSelected(sq); return; }
      if (!tryMove(selected, sq)) setSelected(null);
      return;
    }
    if (piece && piece.color === turn) setSelected(sq);
  };

  // ---------- right-click planning ----------
  const sqOf = (e: { clientX: number; clientY: number }) => {
    const r = frameRef.current?.getBoundingClientRect();
    return r ? squareAt(e.clientX - r.left, e.clientY - r.top, size, orientation) : null;
  };
  const rightActive = planOn || !!premove?.queue.length;
  const onPointerDown = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button === 2) {
      if (!rightActive) return;
      const sq = sqOf(e);
      if (!sq) return;
      e.preventDefault();
      draw.current = { from: sq, color: planColor(e) };
      setPreview(null);
      return;
    }
    if (e.button === 0 && !planMode && hasAnnotations(annos)) setAnnos(EMPTY_ANNOTATIONS);
  };
  const onPointerMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = draw.current;
    if (!d) return;
    const sq = sqOf(e);
    setPreview(sq && sq !== d.from ? { from: d.from, to: sq, color: d.color } : null);
  };
  useEffect(() => {
    const up = (e: PointerEvent) => {
      const d = draw.current;
      if (!d || e.button !== 2) return;
      draw.current = null;
      setPreview(null);
      const to = sqOf(e);
      if (!to) return;
      if (to === d.from) {
        if (premove?.queue.length) { premove.onCancel(); return; }
        if (planOn) setAnnos((a) => toggleMark(a, to, d.color));
      } else if (planOn) setAnnos((a) => toggleArrow(a, d.from, to, d.color));
    };
    window.addEventListener('pointerup', up);
    return () => window.removeEventListener('pointerup', up);
  });

  const styles: Record<string, CSSProperties> = {};
  if (annotation) {
    const hex = CLASS_INFO[annotation.cls].color;
    styles[annotation.from] = { backgroundColor: `${hex}66` };
    styles[annotation.to] = { backgroundColor: `${hex}8c` };
  } else if (lastMove) {
    for (const s of lastMove) styles[s] = { backgroundColor: 'rgba(255, 233, 120, 0.42)' };
  }
  for (const [sq, color] of highlights ?? []) {
    styles[sq] = { ...styles[sq], backgroundColor: `${color}55`, boxShadow: `inset 0 0 0 4px ${color}` };
  }
  if (chess.inCheck()) {
    const k = chess.board().flat().find((p) => p && p.type === 'k' && p.color === turn);
    if (k) styles[k.square] = { ...styles[k.square], backgroundImage: 'radial-gradient(circle, rgba(232,52,44,.95) 0%, rgba(232,52,44,.5) 42%, transparent 72%)' };
  }
  for (const [i, m] of (premove?.queue ?? []).entries()) {
    const a = i === 0 ? 'b3' : '80';
    styles[m.from] = { ...styles[m.from], backgroundColor: `${PREMOVE_COLOR}${a}` };
    styles[m.to] = { ...styles[m.to], backgroundColor: `${PREMOVE_COLOR}${a}` };
  }
  for (const mk of annos.marks) styles[mk.sq] = { ...styles[mk.sq], backgroundColor: `${mk.color}b3` };
  if (planStart) styles[planStart] = { ...styles[planStart], boxShadow: `inset 0 0 0 4px ${PLAN_COLORS.orange}` };
  if (selected && premoveMode) {
    styles[selected] = { ...styles[selected], boxShadow: `inset 0 0 0 3px ${PREMOVE_COLOR}` };
    for (const t of premoveFrom(selected)) styles[t] = { ...styles[t], backgroundImage: `radial-gradient(circle, ${PREMOVE_COLOR}99 18%, transparent 21%)`, cursor: 'pointer' };
  } else if (selected) {
    styles[selected] = { ...styles[selected], boxShadow: 'inset 0 0 0 3px rgba(237,231,213,.95)' };
    if (prefs.showLegalMoves) {
      for (const m of legalFrom(selected)) {
        styles[m.to] = {
          ...styles[m.to],
          backgroundImage: m.captured
            ? 'radial-gradient(circle, transparent 60%, rgba(16,22,18,.42) 62%)'
            : 'radial-gradient(circle, rgba(16,22,18,.4) 21%, transparent 23%)',
          cursor: 'pointer',
        };
      }
    }
  }
  const theme = BOARD_THEMES[prefs.boardTheme as BoardTheme] ?? BOARD_THEMES.walnut;

  // classification stamp on the destination square
  let stamp: JSX.Element | null = null;
  if (annotation && size > 0) {
    const sq = size / 8;
    const icon = Math.max(18, Math.round(sq * 0.44));
    const { col, row } = squareXY(annotation.to, orientation);
    const left = Math.min((col + 1) * sq - icon * 0.8, size - icon);
    const top = Math.max(row * sq - icon * 0.22, 0);
    const mode = reduced ? 'static' : annotation.mode;
    stamp = (
      <div key={annotation.key} className={`stamp${mode === 'animate' ? ' is-anim' : mode === 'quick' ? ' is-quick' : ''}`}
        style={{ left, top, width: icon, height: icon, animationDelay: mode === 'animate' ? `${PIECE_MS - 30}ms` : undefined }}
        data-testid="board-stamp" data-cls={annotation.cls} data-square={annotation.to}>
        <ClassIcon cls={annotation.cls} size={icon} provisional={annotation.provisional} />
      </div>
    );
  }

  // user arrows (solid), a preview while dragging, and queued premoves (dashed)
  const sqPx = size / 8;
  const center = (sq: string) => { const { col, row } = squareXY(sq, orientation); return [(col + 0.5) * sqPx, (row + 0.5) * sqPx] as const; };
  const arrowEl = (key: string, from: string, to: string, color: string, opts: { dashed?: boolean; label?: string; opacity?: number } = {}) => {
    const [x1, y1] = center(from);
    const [x2, y2] = center(to);
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
    const head = sqPx * 0.42, w = sqPx * (opts.dashed ? 0.1 : 0.17);
    const bx = x2 - ux * head, by = y2 - uy * head;
    const sx = x1 + ux * sqPx * 0.2, sy = y1 + uy * sqPx * 0.2;
    const px = -uy * head * 0.55, py = ux * head * 0.55;
    return (
      <g key={key} opacity={opts.opacity ?? 0.78} data-testid={opts.dashed ? 'premove-arrow' : 'plan-arrow'} data-from={from} data-to={to}>
        <line x1={sx} y1={sy} x2={bx} y2={by} stroke={color} strokeWidth={w} strokeLinecap="round" strokeDasharray={opts.dashed ? `${w * 1.6} ${w * 1.4}` : undefined} />
        <polygon points={`${x2},${y2} ${bx + px},${by + py} ${bx - px},${by - py}`} fill={color} />
        {opts.label && <text x={x2} y={y2 - head * 0.9} textAnchor="middle" fontSize={sqPx * 0.26} fontWeight={800} fill="#fff" stroke="#000" strokeWidth={2} paintOrder="stroke">{opts.label}</text>}
      </g>
    );
  };
  const queue = premove?.queue ?? [];
  const planLayer = size > 0 && (annos.arrows.length || preview || queue.length) ? (
    <svg className="plan-layer" width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      {queue.map((m, i) => arrowEl(`p${i}`, m.from, m.to, PREMOVE_COLOR, { dashed: true, label: queue.length > 1 ? String(i + 1) : undefined, opacity: 0.85 }))}
      {annos.arrows.map((a, i) => arrowEl(`a${i}`, a.from, a.to, a.color))}
      {preview && arrowEl('preview', preview.from, preview.to, preview.color, { opacity: 0.55 })}
    </svg>
  ) : null;
  const marked = annos.arrows.length + annos.marks.length;

  return (
    <div ref={frameRef} className={`board-frame${frame === 'explore' ? ' is-explore' : frame === 'predict' ? ' is-predict' : frame === 'demo' ? ' is-demo' : ''}${planMode ? ' is-planning' : ''}`} style={{ width: size, height: size }} data-testid={id} data-fen={fen} data-orientation={orientation}
      data-annotations={marked} data-premoves={queue.length}
      onContextMenu={(e) => { if (rightActive) e.preventDefault(); }} onPointerDown={onPointerDown} onPointerMove={onPointerMove}>
      <Chessboard
        id={id}
        position={fen}
        boardWidth={size}
        boardOrientation={orientation}
        arePiecesDraggable={(interactive || premoveMode) && !planMode}
        isDraggablePiece={({ piece }) => !planMode && (premoveMode ? piece[0] === premove!.color : interactive && piece[0] === turn)}
        onPieceDrop={(from, to) => tryMove(from, to)}
        onSquareClick={(sq) => onSquareClick(sq)}
        onPieceDragBegin={(_p, sq) => setSelected(sq)}
        onPromotionCheck={() => false}
        customSquareStyles={styles}
        customArrows={(arrows ?? []) as never}
        areArrowsAllowed={false}
        arePremovesAllowed={false}
        showBoardNotation={prefs.showCoordinates}
        customDarkSquareStyle={{ backgroundColor: theme.dark }}
        customLightSquareStyle={{ backgroundColor: theme.light }}
        customBoardStyle={{ borderRadius: '6px' }}
        customNotationStyle={{ fontSize: `${Math.max(9, Math.round(size / 52))}px`, fontWeight: 700 }}
        animationDuration={reduced ? 0 : PIECE_MS}
      />
      <div className="board-overlay">{stamp}{planLayer}</div>
      {marked > 0 && <button type="button" className="plan-clear" onClick={() => setAnnos(EMPTY_ANNOTATIONS)} onPointerDown={(e) => e.stopPropagation()} aria-label="Clear arrows and marked squares" title="Clear arrows and marks" data-testid="clear-annotations">✕</button>}
      {promo && (
        <div className="promo-overlay" role="dialog" aria-label="Choose a piece to promote to">
          <div className="promo">
            {PROMO.map(([p, name, g]) => (
              <button key={p} type="button" aria-label={`Promote to ${name}`} data-testid={`promo-${p}`} className={turn === 'w' ? 'is-white' : 'is-black'}
                onClick={() => { const pr = promo; setPromo(null); onMove?.({ from: pr.from, to: pr.to, promotion: p }); }}>{g}</button>
            ))}
            <button type="button" className="promo-cancel" aria-label="Cancel promotion" onClick={() => setPromo(null)}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A small static board for previews (settings themes, home). */
export function MiniBoard({ theme, fen = 'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R' }: { theme: BoardTheme; fen?: string }) {
  const t = BOARD_THEMES[theme];
  const rows = fen.split(' ')[0].split('/');
  const glyph: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  const cells: JSX.Element[] = [];
  rows.forEach((row, r) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { for (let i = 0; i < +ch; i++) { cells.push(<span key={`${r}-${f}`} style={{ background: (r + f) % 2 ? t.dark : t.light }} />); f++; } continue; }
      const white = ch === ch.toUpperCase();
      cells.push(
        <span key={`${r}-${f}`} style={{ background: (r + f) % 2 ? t.dark : t.light, display: 'grid', placeItems: 'center', fontSize: '0.62em', lineHeight: 1, color: white ? '#fbf8ef' : '#1a1a17', textShadow: white ? '0 0 1px #000, 0 0 1px #000' : 'none' }}>{glyph[ch.toLowerCase()]}</span>,
      );
      f++;
    }
  });
  return <div className="mini-board" aria-hidden="true">{cells}</div>;
}

/**
 * Touch-friendly planning: while on, tapping two squares draws an arrow and
 * tapping one square twice marks it, instead of moving pieces. Shown on touch
 * screens; with a mouse, right-click and drag does the same.
 */
export function PlanToggle() {
  const { prefs } = useApp();
  const on = usePlanMode();
  useEffect(() => () => setPlanMode(false), []);
  if (!prefs.planning) return null;
  return (
    <button type="button" className="btn btn-sm btn-quiet touch-only" aria-pressed={on} onClick={() => setPlanMode(!on)} data-testid="plan-toggle"
      title="Plan mode: tap two squares to draw an arrow, or one square twice to mark it. Pieces do not move while it is on.">
      <IconPencil size={16} /> {on ? 'Planning on' : 'Plan'}
    </button>
  );
}
