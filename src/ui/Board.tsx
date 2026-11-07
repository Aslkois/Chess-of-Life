import { Chess, type Square } from 'chess.js';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Chessboard } from 'react-chessboard';
import { CLASS_INFO, type Classification } from '../analysis/classify';
import { useApp } from './context';
import { ClassIcon } from './ClassIcon';
import { prefersReducedMotion } from './useKeys';

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
}

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
export function Board({ fen, orientation, size, movable, onMove, lastMove, annotation, arrows, highlights, frame = 'normal', id = 'board' }: BoardProps) {
  const { prefs } = useApp();
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => { setSelected(null); setPromo(null); }, [fen]);

  const chess = useMemo(() => { try { return new Chess(fen); } catch { return new Chess(); } }, [fen]);
  const turn = chess.turn();
  const interactive = movable !== 'none' && (movable === 'both' || movable === turn) && !chess.isGameOver();
  const legalFrom = (sq: string) => chess.moves({ square: sq as Square, verbose: true });
  const reduced = prefersReducedMotion();

  const tryMove = (from: string, to: string, promotion?: string): boolean => {
    if (!interactive) return false;
    const legal = legalFrom(from).filter((m) => m.to === to);
    if (!legal.length) return false;
    if (legal.some((m) => m.promotion) && !promotion) { setPromo({ from, to }); return false; }
    const ok = onMove?.({ from, to, promotion });
    setSelected(null);
    return ok !== false;
  };

  const onSquareClick = (sq: string) => {
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
  if (selected) {
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

  return (
    <div className={`board-frame${frame === 'explore' ? ' is-explore' : frame === 'predict' ? ' is-predict' : frame === 'demo' ? ' is-demo' : ''}`} style={{ width: size, height: size }} data-testid={id} data-fen={fen} data-orientation={orientation}>
      <Chessboard
        id={id}
        position={fen}
        boardWidth={size}
        boardOrientation={orientation}
        arePiecesDraggable={interactive}
        isDraggablePiece={({ piece }) => interactive && piece[0] === turn}
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
      <div className="board-overlay">{stamp}</div>
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
