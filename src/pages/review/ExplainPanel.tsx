import type { Classification } from '../../analysis/classify';
import { CLASS_INFO } from '../../analysis/classify';
import type { Explanation, XLine, XMarks, XTone } from '../../analysis/explainMove';
import type { BoardMarks } from '../../ui/Board';
import { formatScore } from '../../engine/score';
import { IconFirst, IconLast, IconNext, IconPrev } from '../../ui/icons';

/** What the board shows while an explanation is open. */
export type ExplainView =
  | { k: 'point'; i: number }
  | { k: 'line'; id: XLine['id']; step: number };

const TONE: Record<Exclude<XTone, 'played'>, string> = { threat: '#e5443a', better: '#62b03c', concept: '#f09b48', plan: '#4f8ef0', defend: '#4f8ef0' };

/** Translate explanation marks into board marks (the played move takes its classification colour). */
export function toBoardMarks(m: XMarks, cls: Classification): BoardMarks {
  const color = (t: XTone) => (t === 'played' ? CLASS_INFO[cls].color : TONE[t]);
  return {
    arrows: m.arrows.map((a) => ({ from: a.from, to: a.to, color: color(a.tone), dashed: a.dashed || a.tone === 'defend', label: a.label })),
    squares: m.squares.map((s) => ({ sq: s.sq, color: color(s.tone), style: s.style })),
    icons: m.icons,
  };
}

/** The board state for the current view of an explanation. */
export function explainBoard(x: Explanation, view: ExplainView): { fen: string; marks: XMarks; lastMove: [string, string] | null } {
  if (view.k === 'point') {
    const p = x.points[view.i] ?? x.points[0];
    return { fen: p.fen, marks: p.marks, lastMove: p.lastMove ?? null };
  }
  const line = x.lines.find((l) => l.id === view.id);
  if (!line) return { fen: x.fenAfter, marks: { arrows: [], squares: [], icons: [] }, lastMove: null };
  if (view.step === 0) return { fen: line.startFen, marks: line.startMarks, lastMove: null };
  const st = line.steps[Math.min(view.step, line.steps.length) - 1];
  return { fen: st.fen, marks: st.marks, lastMove: [st.uci.slice(0, 2), st.uci.slice(2, 4)] };
}

export function ExplainPanel({ x, cls, view, onView, onClose }: { x: Explanation; cls: Classification; view: ExplainView; onView: (v: ExplainView) => void; onClose: () => void }) {
  const has = (id: XLine['id']) => x.lines.some((l) => l.id === id);
  const bad = ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(cls);
  const lv = view.k === 'line' ? view : null;
  const line = lv ? x.lines.find((l) => l.id === lv.id) ?? null : null;
  const cmp = x.compare;
  const otherId = cmp && line ? (line.id === cmp.aLine ? cmp.bLine : line.id === cmp.bLine ? cmp.aLine : null) : null;
  return (
    <section className="explain" data-testid="explanation" aria-label="Explanation of the move">
      <div className="explain-head">
        <span className="teach-kind">{x.label}</span>
        <span className="small dim ellipsis">{x.headline}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm btn-quiet" onClick={onClose} data-testid="explain-close" title="Close the explanation (Esc)">Close</button>
      </div>

      {view.k === 'point' && (
        <ul className="teach-points" data-testid="explain-points">
          {x.points.map((p, i) => (
            <li key={i}>
              <button type="button" className="teach-point has-mark" aria-pressed={view.i === i} onClick={() => onView({ k: 'point', i })} data-testid="explain-point">{p.text}</button>
            </li>
          ))}
        </ul>
      )}

      {line && lv && (
        <div data-testid="explain-line" data-line={line.id}>
          <div className="row-nowrap" style={{ marginBottom: 'var(--s-2)' }}>
            <h3 className="section-title" style={{ margin: 0 }}>{line.label}</h3>
            <span className={`op-badge ${line.forced ? 'is-book' : 'is-out'}`} title={line.forced ? 'Checks, captures and forced replies' : 'A possible continuation; the opponent has other moves'}>{line.forced ? 'Forcing line' : 'Possible continuation'}</span>
          </div>
          <ol className="demo-notation" aria-label="Moves of the line">
            <li><button type="button" className="demo-move is-start" aria-current={lv.step === 0 ? 'step' : undefined} onClick={() => onView({ ...lv, step: 0 })}>Start</button></li>
            {line.steps.map((st, i) => (
              <li key={i}>
                {(st.color === 'w' || i === 0) && <span className="demo-no">{st.moveNo}</span>}
                <button type="button" className="demo-move by-you" aria-current={lv.step === i + 1 ? 'step' : undefined} onClick={() => onView({ ...lv, step: i + 1 })} data-testid="line-move">{st.san}</button>
              </li>
            ))}
          </ol>
          <div className="demo-caption" aria-live="polite" data-testid="line-caption">
            {lv.step === 0 ? <span className="small">{line.intro}</span> : (
              <>
                <b>{line.steps[lv.step - 1].moveNo} {line.steps[lv.step - 1].san}</b>
                {line.steps[lv.step - 1].text && <div className="small" style={{ marginTop: 4 }}>{line.steps[lv.step - 1].text}</div>}
                {lv.step === line.steps.length && <div className="small dim" style={{ marginTop: 4 }}>{line.summary}</div>}
              </>
            )}
          </div>
          <div className="demo-controls">
            <div className="row-nowrap" style={{ gap: 4 }}>
              <button type="button" className="btn btn-icon" onClick={() => onView({ ...lv, step: 0 })} disabled={lv.step === 0} aria-label="Start of the line"><IconFirst /></button>
              <button type="button" className="btn btn-icon" onClick={() => onView({ ...lv, step: lv.step - 1 })} disabled={lv.step === 0} aria-label="Previous half-move" title="Previous ([)" data-testid="line-prev"><IconPrev /></button>
              <button type="button" className="btn btn-icon" onClick={() => onView({ ...lv, step: lv.step + 1 })} disabled={lv.step >= line.steps.length} aria-label="Next half-move" title="Next (])" data-testid="line-next"><IconNext /></button>
              <button type="button" className="btn btn-icon" onClick={() => onView({ ...lv, step: line.steps.length })} disabled={lv.step >= line.steps.length} aria-label="End of the line"><IconLast /></button>
            </div>
            {otherId && <button type="button" className="btn btn-sm" onClick={() => onView({ k: 'line', id: otherId, step: Math.min(lv.step, x.lines.find((l) => l.id === otherId)!.steps.length) })} data-testid="compare-switch">Switch to {x.lines.find((l) => l.id === otherId)!.label.replace(/^Best: /, '')}</button>}
            <button type="button" className="btn btn-sm btn-quiet" onClick={() => onView({ k: 'point', i: 0 })} data-testid="line-return">Return</button>
          </div>
        </div>
      )}

      {cmp && view.k === 'point' && (
        <div className="compare-grid" data-testid="explain-compare">
          {[cmp.a, cmp.b].map((side, i) => (
            <div key={i} className={`compare-col${i === 1 ? ' is-best' : ''}`}>
              <span className="faint xs">{i === 0 ? 'Played' : bad || cmp.bLine === 'best' ? 'Engine’s choice' : 'Second best'}</span>
              <b>{side.san}</b>
              <div>{formatScore(side.score ?? undefined)} · {side.win.toFixed(0)}% winning chances</div>
              <div className="faint" style={{ marginTop: 4 }}>{side.line}</div>
            </div>
          ))}
        </div>
      )}
      {cmp?.approxEqual && view.k === 'point' && <p className="xs faint" style={{ margin: '0 0 var(--s-2)' }}>The two moves are practically equal; the engine sees no meaningful difference.</p>}

      <div className="teach-actions" data-testid="explain-actions">
        {has('best') && <button type="button" className="btn btn-sm" aria-pressed={view.k === 'line' && view.id === 'best'} onClick={() => onView({ k: 'line', id: 'best', step: 0 })} data-testid="show-best-line">Show best</button>}
        {cmp && <button type="button" className="btn btn-sm" aria-pressed={view.k === 'line' && (view.id === cmp.aLine || view.id === cmp.bLine)} onClick={() => onView({ k: 'line', id: view.k === 'line' && view.id === cmp.aLine ? cmp.bLine : cmp.aLine, step: view.k === 'line' ? view.step : 1 })} data-testid="compare-lines">Compare</button>}
        {has('played') && <button type="button" className="btn btn-sm" aria-pressed={view.k === 'line' && view.id === 'played'} onClick={() => onView({ k: 'line', id: 'played', step: 0 })} data-testid="show-played-line">{bad ? 'How it is punished' : 'The follow-up'}</button>}
        {has('second') && <button type="button" className="btn btn-sm" aria-pressed={view.k === 'line' && view.id === 'second'} onClick={() => onView({ k: 'line', id: 'second', step: 0 })} data-testid="show-second-line">Second best</button>}
        {has('exchange') && <button type="button" className="btn btn-sm" aria-pressed={view.k === 'line' && view.id === 'exchange'} onClick={() => onView({ k: 'line', id: 'exchange', step: 0 })} data-testid="show-exchange-line">{x.lines.find((l) => l.id === 'exchange')!.label}</button>}
      </div>
    </section>
  );
}
