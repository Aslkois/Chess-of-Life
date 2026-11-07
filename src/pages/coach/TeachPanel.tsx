import type { Classification } from '../../analysis/classify';
import type { Comparison, DemoLine, Teaching } from '../../coach/teach';
import { ClassIcon } from '../../ui/ClassIcon';
import { IconFirst, IconLast, IconNext, IconPlay, IconPrev } from '../../ui/icons';
import { formatScore } from '../../engine/score';

export type TeachView =
  | { k: 'points' }
  | { k: 'demo'; line: DemoLine; step: number; playing: boolean }
  | { k: 'compare'; cmp: Comparison };

const KIND_LABEL: Record<Teaching['kind'], string> = {
  tactical: 'Tactical', positional: 'Positional', mate: 'Mate threat', missed: 'Missed chance', strong: 'Strong move', quiet: '',
};

/**
 * Feedback on the player's last move, with the teaching actions. In
 * `blocking` mode the move is not yet committed (Retry / Continue); otherwise
 * it is a note about a played move (Take back / Dismiss).
 */
export function TeachPanel({
  teaching, cls, provisional, blocking, view, focus, onFocus, onShowWhy, onBest, onCompare, onRetry, onContinue, onDismiss,
  onStep, onTogglePlay, onReturn,
}: {
  teaching: Teaching; cls: Classification; provisional: boolean; blocking: boolean; view: TeachView; focus: number | null;
  onFocus: (i: number | null) => void; onShowWhy: () => void; onBest: () => void; onCompare: () => void; onRetry: () => void;
  onContinue?: () => void; onDismiss?: () => void; onStep: (step: number) => void; onTogglePlay: () => void; onReturn: () => void;
}) {
  const bad = ['inaccuracy', 'mistake', 'miss', 'blunder'].includes(cls);
  const toneClass = teaching.tone === 'bad' ? 'tone-bad' : teaching.tone === 'warn' ? 'tone-warn' : teaching.tone === 'info' ? 'tone-info' : 'tone-good';
  return (
    <div className={`feedback sheet-mobile ${toneClass}${view.k !== 'points' ? ' is-demo' : ''}`} data-testid="coach-feedback" role="region" aria-label="Feedback on your move">
      <div className="feedback-head">
        <ClassIcon cls={cls} size="md" provisional={provisional} />
        <h2 id="fb-title">{teaching.headline}</h2>
        {KIND_LABEL[teaching.kind] && <span className="teach-kind">{KIND_LABEL[teaching.kind]}</span>}
      </div>

      {view.k === 'points' && (
        <>
          <ul className="teach-points" data-testid="teach-points">
            {teaching.points.map((p, i) => (
              <li key={i}>
                <button type="button" className={`teach-point${p.mark ? ' has-mark' : ''}`} aria-pressed={p.mark ? focus === i : undefined}
                  onClick={() => p.mark && onFocus(focus === i ? null : i)} title={p.mark ? 'Show this on the board' : undefined} data-testid="teach-point">
                  {p.text}
                </button>
              </li>
            ))}
          </ul>
          {teaching.points.some((p) => p.mark) && <p className="xs faint" style={{ margin: '0 0 var(--s-3)' }}>Select a point to see it on the board.</p>}
        </>
      )}

      {view.k === 'demo' && <DemoView view={view} onStep={onStep} onTogglePlay={onTogglePlay} onReturn={onReturn} />}
      {view.k === 'compare' && <CompareView cmp={view.cmp} onBest={onBest} onReturn={onReturn} />}

      <div className="teach-actions" data-testid="teach-actions">
        {teaching.why && <button type="button" className="btn" onClick={onShowWhy} aria-pressed={view.k === 'demo' && view.line.kind !== 'best'} data-testid="show-why">{bad ? 'Show why' : 'Show the idea'}</button>}
        {teaching.best && <button type="button" className="btn" onClick={onBest} aria-pressed={view.k === 'demo' && view.line.kind === 'best'} data-testid="best-move">Best move</button>}
        {teaching.compare && <button type="button" className="btn" onClick={onCompare} aria-pressed={view.k === 'compare'} data-testid="compare">Compare</button>}
      </div>
      <div className="teach-decide">
        <button type="button" className={blocking ? 'btn btn-primary' : 'btn'} onClick={onRetry} data-testid={blocking ? 'take-back' : 'take-back-note'} title="Undo this move and choose again">Retry</button>
        {blocking && onContinue && <button type="button" className="btn" onClick={onContinue} data-testid="continue">Continue</button>}
        {!blocking && onDismiss && <button type="button" className="btn btn-quiet" onClick={onDismiss} data-testid="dismiss-feedback">Dismiss</button>}
      </div>
      {blocking && <p className="xs faint" style={{ margin: 'var(--s-2) 0 0' }}>Retry and Continue are both fine. Your first try at a position is what counts as your own decision.</p>}
    </div>
  );
}

function DemoView({ view, onStep, onTogglePlay, onReturn }: { view: Extract<TeachView, { k: 'demo' }>; onStep: (s: number) => void; onTogglePlay: () => void; onReturn: () => void }) {
  const { line, step } = view;
  const n = line.steps.length;
  const cur = step > 0 ? line.steps[step - 1] : null;
  return (
    <div data-testid="demo">
      <h3 className="section-title" style={{ marginBottom: 'var(--s-2)' }}>{line.title}</h3>
      <div className="demo-caption" aria-live="polite" data-testid="demo-caption">
        {cur ? (
          <>
            <b>{cur.san}</b> <span className="faint small">{cur.by === 'you' ? 'you' : 'your opponent'}, step {step} of {n}</span>
            {cur.text && <div className="small" style={{ marginTop: 4 }}>{cur.text}</div>}
            {step === n && <div className="small dim" style={{ marginTop: 4 }}>{line.summary}</div>}
          </>
        ) : <span className="small">{line.intro}</span>}
      </div>
      <div className="demo-controls">
        <div className="row-nowrap" style={{ gap: 4 }}>
          <button type="button" className="btn btn-icon" onClick={() => onStep(0)} disabled={step === 0} aria-label="Start of the line"><IconFirst /></button>
          <button type="button" className="btn btn-icon" onClick={() => onStep(step - 1)} disabled={step === 0} aria-label="Previous move" data-testid="demo-prev"><IconPrev /></button>
          <button type="button" className="btn btn-icon" onClick={() => onStep(step + 1)} disabled={step >= n} aria-label="Next move" data-testid="demo-next"><IconNext /></button>
          <button type="button" className="btn btn-icon" onClick={() => onStep(n)} disabled={step >= n} aria-label="End of the line"><IconLast /></button>
        </div>
        <button type="button" className="btn btn-sm" onClick={onTogglePlay} aria-pressed={view.playing} data-testid="demo-play"><IconPlay size={14} /> {view.playing ? 'Pause' : step >= n ? 'Replay' : 'Play'}</button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={onReturn} data-testid="demo-return">Return to position</button>
        <div className="demo-dots" aria-hidden="true">{line.steps.map((_, i) => <i key={i} className={i < step ? 'on' : ''} />)}</div>
      </div>
    </div>
  );
}

function CompareView({ cmp, onBest, onReturn }: { cmp: Comparison; onBest: () => void; onReturn: () => void }) {
  const col = (side: Comparison['played'], best: boolean) => (
    <div className={`compare-col${best ? ' is-best' : ''}`}>
      <span className="faint xs">{best ? 'Best move' : 'You played'}</span>
      <b>{side.san}</b>
      <div>{side.win.toFixed(0)}% winning chances ({formatScore(side.score)})</div>
      <div className="dim">{side.material === 0 ? 'Material stays level' : (() => { const m = Math.ceil(Math.max(side.plies, 1) / 2); return `${side.material > 0 ? 'You win' : 'You lose'} ${Math.abs(side.material)} pawn${Math.abs(side.material) === 1 ? '' : 's'} of material within ${m} move${m === 1 ? '' : 's'}`; })()}</div>
      <div className="faint" style={{ marginTop: 4 }}>{side.line}</div>
    </div>
  );
  return (
    <div data-testid="compare-view">
      <div className="compare-grid">{col(cmp.played, false)}{col(cmp.best, true)}</div>
      <p className="small dim" style={{ marginTop: 0 }}>The difference is {cmp.epl.toFixed(0)} expected points out of 100. Orange shows your move, green the better one.</p>
      <div className="row" style={{ marginBottom: 'var(--s-3)' }}>
        <button type="button" className="btn btn-sm" onClick={onBest}>Play through the best line</button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={onReturn} data-testid="compare-return">Return to position</button>
      </div>
    </div>
  );
}
