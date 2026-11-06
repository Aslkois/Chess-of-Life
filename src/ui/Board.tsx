import { Chess, type Square } from 'chess.js';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Chessboard } from 'react-chessboard';
import { useApp } from './context';

export interface BoardMove { from: string; to: string; promotion?: string }

export interface BoardProps {
  fen: string;
  orientation: 'white' | 'black';
  /** which side's pieces the user may move */
  movable: 'w' | 'b' | 'both' | 'none';
  onMove?: (m: BoardMove) => boolean | void;
  lastMove?: [string, string] | null;
  /** review-only arrows: [from, to, color] */
  arrows?: [string, string, string][];
  marks?: Record<string, CSSProperties>;
  id?: string;
}

const THEMES = {
  moss: { light: '#c9cfbf', dark: '#6b8565' },
  slate: { light: '#c3c9cf', dark: '#5f7280' },
  sand: { light: '#ded2b8', dark: '#9c8461' },
};

const PROMO = [['q', '♛'], ['r', '♜'], ['b', '♝'], ['n', '♞']] as const;

/**
 * Interactive board: drag-and-drop and click-to-move, legal-move enforcement
 * through chess.js, our own promotion picker. It never shows engine hints;
 * arrows are only passed in by the review screen.
 */
export function Board({ fen, orientation, movable, onMove, lastMove, arrows, marks, id = 'board' }: BoardProps) {
  const { prefs } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(480);
  const [selected, setSelected] = useState<string | null>(null);
  const [promo, setPromo] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    setWidth(Math.max(200, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);

  useEffect(() => { setSelected(null); setPromo(null); }, [fen]);

  const chess = useMemo(() => { try { return new Chess(fen); } catch { return new Chess(); } }, [fen]);
  const turn = chess.turn();
  const canMoveColor = (c: 'w' | 'b') => movable === 'both' || movable === c;
  const interactive = movable !== 'none' && canMoveColor(turn) && !chess.isGameOver();

  const legalFrom = (sq: string) => chess.moves({ square: sq as Square, verbose: true });

  const tryMove = (from: string, to: string, promotion?: string): boolean => {
    if (!interactive) return false;
    const legal = legalFrom(from).filter((m) => m.to === to);
    if (!legal.length) return false;
    if (legal.some((m) => m.promotion) && !promotion) {
      setPromo({ from, to });
      return false;
    }
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

  const squareStyles: Record<string, CSSProperties> = {};
  if (lastMove) for (const s of lastMove) squareStyles[s] = { background: 'rgba(222, 214, 120, 0.38)' };
  if (chess.inCheck()) {
    const k = chess.board().flat().find((p) => p && p.type === 'k' && p.color === turn);
    if (k) squareStyles[k.square] = { ...squareStyles[k.square], background: 'radial-gradient(circle, rgba(235,64,64,.85) 0%, rgba(235,64,64,.35) 45%, transparent 72%)' };
  }
  if (selected) {
    squareStyles[selected] = { ...squareStyles[selected], background: 'rgba(143, 193, 122, 0.55)' };
    if (prefs.showLegalMoves) {
      for (const m of legalFrom(selected)) {
        squareStyles[m.to] = {
          ...squareStyles[m.to],
          background: m.captured
            ? 'radial-gradient(circle, transparent 58%, rgba(10,20,8,.45) 60%)'
            : 'radial-gradient(circle, rgba(10,20,8,.42) 22%, transparent 24%)',
          cursor: 'pointer',
        };
      }
    }
  }
  Object.assign(squareStyles, marks ?? {});
  const theme = THEMES[prefs.boardTheme] ?? THEMES.moss;

  return (
    <div className="board-host" ref={host} data-testid={id} data-fen={fen}>
      <Chessboard
        id={id}
        position={fen}
        boardWidth={width}
        boardOrientation={orientation}
        arePiecesDraggable={interactive}
        isDraggablePiece={({ piece }) => interactive && piece[0] === turn}
        onPieceDrop={(from, to) => tryMove(from, to)}
        onSquareClick={(sq) => onSquareClick(sq)}
        onPieceDragBegin={(_p, sq) => setSelected(sq)}
        onPromotionCheck={() => false}
        customSquareStyles={squareStyles}
        customArrows={(arrows ?? []) as never}
        areArrowsAllowed={false}
        arePremovesAllowed={false}
        showBoardNotation={prefs.showCoordinates}
        customDarkSquareStyle={{ backgroundColor: theme.dark }}
        customLightSquareStyle={{ backgroundColor: theme.light }}
        customBoardStyle={{ borderRadius: '4px', boxShadow: '0 0 0 1px #20262b' }}
        animationDuration={160}
      />
      {promo && (
        <div className="overlay" role="dialog" aria-label="Choose promotion piece">
          <div className="promo">
            {PROMO.map(([p, g]) => (
              <button key={p} aria-label={`Promote to ${p}`} data-testid={`promo-${p}`} onClick={() => { const pr = promo; setPromo(null); onMove?.({ from: pr.from, to: pr.to, promotion: p }); }}>{g}</button>
            ))}
            <button aria-label="Cancel" onClick={() => setPromo(null)} style={{ fontSize: 18, background: '#30383e', color: '#eee' }}>✕</button>
          </div>
        </div>
      )}
    </div>
  );
}
