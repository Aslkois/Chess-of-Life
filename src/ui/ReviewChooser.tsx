import { useEffect, useRef, useState } from 'react';
import { get } from '../db/db';
import { Dialog } from './Dialog';
import { IconReconstruct, IconUpload } from './icons';
import { useApp } from './context';
import { navigate } from './router';

/**
 * Entry point to Game Review: choose how the game gets in. Arrow keys move
 * between the two options; Escape or the close button dismisses.
 */
export function ReviewChooser() {
  const { chooserOpen, closeChooser } = useApp();
  const [draftMoves, setDraftMoves] = useState(0);
  const grid = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!chooserOpen) return;
    get('drafts', 'current').then((d) => setDraftMoves(d?.moves.length ?? 0)).catch(() => setDraftMoves(0));
  }, [chooserOpen]);

  const go = (path: string) => { closeChooser(); navigate(path); };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
    const items = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>('.choice') ?? []);
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
    e.preventDefault();
  };

  return (
    <Dialog open={chooserOpen} onClose={closeChooser} wide title="Review a game" description="Choose how to bring the game in. Both paths lead to the same full review." testId="review-chooser"
      footer={<button type="button" className="btn btn-quiet" onClick={() => go('library')}>Open a saved game instead</button>}>
      <div className="choices" ref={grid} onKeyDown={onKeyDown} role="group" aria-label="Ways to add a game">
        <button type="button" className="choice" onClick={() => go('reconstruct')} data-autofocus data-testid="choose-reconstruct">
          <span className="choice-icon"><IconReconstruct size={28} /></span>
          <span className="choice-title">Reconstruct a game</span>
          <span className="choice-desc">Enter both players' moves on a chessboard to recreate a game you played. Ideal for games without a PGN recording.</span>
          {draftMoves > 0 && <span className="choice-extra">Continue your unfinished reconstruction ({draftMoves} move{draftMoves === 1 ? '' : 's'} entered)</span>}
        </button>
        <button type="button" className="choice" onClick={() => go('import')} data-testid="choose-import">
          <span className="choice-icon"><IconUpload size={28} /></span>
          <span className="choice-title">Import PGN</span>
          <span className="choice-desc">Paste a PGN or upload a file to review recorded games. Supports importing multiple games at once.</span>
          <span className="choice-extra">Works with exports from chess sites and apps</span>
        </button>
      </div>
    </Dialog>
  );
}
