import { IconFirst, IconLast, IconNext, IconPrev } from './icons';

/** First / Previous / Next / Last. Disabled buttons explain why in their title. */
export function ReplayControls({ atStart, atEnd, onFirst, onPrev, onNext, onLast, label = 'move' }: {
  atStart: boolean; atEnd: boolean; onFirst: () => void; onPrev: () => void; onNext: () => void; onLast: () => void; label?: string;
}) {
  return (
    <div className="replay" role="group" aria-label="Replay controls">
      <button type="button" className="replay-btn" onClick={onFirst} disabled={atStart} aria-label="First position" title={atStart ? 'Already at the start' : 'First position (Home)'} data-testid="first"><IconFirst /></button>
      <button type="button" className="replay-btn is-main" onClick={onPrev} disabled={atStart} aria-label={`Previous ${label}`} title={atStart ? 'Already at the start' : `Previous ${label} (←)`} data-testid="prev"><IconPrev size={24} /></button>
      <button type="button" className="replay-btn is-main" onClick={onNext} disabled={atEnd} aria-label={`Next ${label}`} title={atEnd ? 'No later move on this line' : `Next ${label} (→)`} data-testid="next"><IconNext size={24} /></button>
      <button type="button" className="replay-btn" onClick={onLast} disabled={atEnd} aria-label="Last position" title={atEnd ? 'Already at the end' : 'Last position (End)'} data-testid="last"><IconLast /></button>
    </div>
  );
}
