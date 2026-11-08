import type { Classification } from '../../analysis/classify';
import type { Comparison, DemoLine, Teaching } from '../../coach/teach';
import { ClassIcon } from '../../ui/ClassIcon';
import { IconFirst, IconLast, IconNext, IconPlay, IconPrev } from '../../ui/icons';
import { formatScore } from '../../engine/score';
import { moveLabel, type ReplayAction, type ReplaySpeed, type ReplayState } from '../../coach/replay';

export type TeachView =
  | { k: 'points' }
  | { k: 'demo'; line: DemoLine; rp: ReplayState }
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
  onReplay, onReturn,
}: {
  teaching: Teaching; cls: Classification; provisional: boolean; blocking: boolean; view: TeachView; focus: number | null;
  onFocus: (i: number | null) => void; onShowWhy: () => void; onBest: () => void; onCompare: () => void; onRetry: () => void;
  onContinue?: () => void; onDismiss?: () => void; onReplay: (a: ReplayAction) => void; onReturn: () => void;
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

      {view.k === 'demo' && <DemoView view={view} onReplay={onReplay} onReturn={onReturn} />}
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

const SPEEDS: ReplaySpeed[] = [0.5, 1, 2];

function DemoView({ view, onReplay, onReturn }: { view: Extract<TeachView, { k: 'demo' }>; onReplay: (a: ReplayAction) => void; onReturn: () => void }) {
  const { line, rp } = view;
  const { step } = rp;
  const n = line.steps.length;
  const cur = step > 0 ? line.steps[step - 1] : null;
  return (
    <div data-testid="demo">
      <h3 className="section-title" style={{ marginBottom: 'var(--s-2)' }}>{line.title}</h3>
      <ol className="demo-notation" aria-label="Moves of the demonstration" data-testid="demo-notation">
        <li><button type="button" className="demo-move is-start" aria-current={step === 0 ? 'step' : undefined} onClick={() => onReplay({ t: 'goto', step: 0 })}>Start</button></li>
        {line.steps.map((st, i) => {
          const ml = moveLabel(line.startFen, i);
          return (
            <li key={i}>
              {(ml.white || i === 0) && <span className="demo-no">{ml.label}</span>}
              <button type="button" className={`demo-move${st.by === 'you' ? ' by-you' : ''}`} aria-current={step === i + 1 ? 'step' : undefined}
                onClick={() => onReplay({ t: 'goto', step: i + 1 })} data-testid="demo-move" title={st.text || undefined}>{st.san}</button>
            </li>
          );
        })}
      </ol>
      <div className="demo-caption" aria-live="polite" data-testid="demo-caption">
        {cur ? (
          <>
            <b>{moveLabel(line.startFen, step - 1).label} {cur.san}</b> <span className="faint small">{cur.by === 'you' ? 'you' : 'your opponent'}, move {step} of {n}</span>
            {cur.text && <div className="small" style={{ marginTop: 4 }}>{cur.text}</div>}
            {step === n && <div className="small dim" style={{ marginTop: 4 }}>{line.summary}</div>}
          </>
        ) : <span className="small">{line.intro}</span>}
      </div>
      <div className="demo-controls">
        <div className="row-nowrap" style={{ gap: 4 }}>
          <button type="button" className="btn btn-icon" onClick={() => onReplay({ t: 'first' })} disabled={step === 0} aria-label="First: start of the line" title="First (Home)" data-testid="demo-first"><IconFirst /></button>
          <button type="button" className="btn btn-icon" onClick={() => onReplay({ t: 'prev' })} disabled={step === 0} aria-label="Previous move" title="Previous (←)" data-testid="demo-prev"><IconPrev /></button>
          <button type="button" className="btn btn-icon" onClick={() => onReplay({ t: 'next' })} disabled={step >= n} aria-label="Next move" title="Next (→)" data-testid="demo-next"><IconNext /></button>
          <button type="button" className="btn btn-icon" onClick={() => onReplay({ t: 'last' })} disabled={step >= n} aria-label="Last: end of the line" title="Last (End)" data-testid="demo-last"><IconLast /></button>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => onReplay({ t: 'toggle' })} aria-pressed={rp.playing} data-testid="demo-play" title="Play or pause (Space)"><IconPlay size={14} /> {rp.playing ? 'Pause' : 'Play'}</button>
        <button type="button" className="btn btn-sm btn-quiet" onClick={() => onReplay({ t: 'replay' })} data-testid="demo-replay">Replay</button>
        <div className="seg seg-sm" role="group" aria-label="Playback speed">
          {SPEEDS.map((sp) => <button key={sp} type="button" aria-pressed={rp.speed === sp} onClick={() => onReplay({ t: 'speed', speed: sp })} data-testid={`demo-speed-${sp}`}>{sp}×</button>)}
        </div>
        <button type="button" className="btn btn-sm btn-quiet" onClick={onReturn} data-testid="demo-return">Return to the game</button>
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
