import type { GameReview } from '../../analysis/review';
import { CLASS_INFO, CLASS_ORDER } from '../../analysis/classify';
import { ClassIcon } from '../../ui/ClassIcon';
import { winLabel } from '../../engine/score';

export function SummaryPanel({ review, whiteName, blackName, onGoto }: { review: GameReview | null; whiteName: string; blackName: string; onGoto: (nodeId: string) => void }) {
  if (!review) return <div className="section dim">Analysis is starting…</div>;
  const box = (name: string, acc: number | null, color: 'w' | 'b') => (
    <div className="acc-box">
      <div className="who"><span className="player-dot" style={{ background: color === 'w' ? '#efeadb' : '#191c19' }} />{name}</div>
      <div className="val" data-testid={`accuracy-${color}`}>{acc === null ? '–' : acc.toFixed(1)}</div>
      <div className="xs faint">accuracy</div>
    </div>
  );
  const moves = review.moves.filter(Boolean);
  return (
    <div data-testid="review-summary">
      <div className="section">
        <div className="acc-duo">{box(whiteName, review.accuracy.w, 'w')}{box(blackName, review.accuracy.b, 'b')}</div>
        {review.status !== 'complete' && <p className="xs faint" style={{ marginTop: 'var(--s-2)', marginBottom: 0 }}>Provisional until the deep pass finishes.</p>}
      </div>
      {review.turningPoints.length > 0 && (
        <div className="section">
          <h3 className="section-title">Turning points</h3>
          <div className="stack" style={{ gap: 4 }}>
            {review.turningPoints.map((i) => {
              const m = moves[i];
              if (!m) return null;
              return (
                <button key={i} type="button" className="engine-line" onClick={() => onGoto(m.nodeId)}>
                  <ClassIcon cls={m.cls} size="sm" provisional={m.provisional} />
                  <span style={{ color: 'var(--ivory)', fontWeight: 650 }}>{Math.ceil(m.ply / 2)}{m.color === 'w' ? '.' : '…'} {m.san}</span>
                  <span>{CLASS_INFO[m.cls].label}, winning chances {winLabel(m.evalBefore, m.color)} → {winLabel(m.evalAfter, m.color)}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="section">
        <h3 className="section-title">Move ratings</h3>
        <table className="cls-table">
          <thead><tr><th /><th>{whiteName}</th><th>{blackName}</th></tr></thead>
          <tbody>
            {CLASS_ORDER.map((c) => (
              <tr key={c}>
                <td><span className="row-nowrap"><ClassIcon cls={c} size="sm" decorative />{CLASS_INFO[c].label}</span></td>
                <td className={`n${review.counts.w[c] ? '' : ' zero'}`}>{review.counts.w[c]}</td>
                <td className={`n${review.counts.b[c] ? '' : ' zero'}`}>{review.counts.b[c]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="section">
        <h3 className="section-title">Summary</h3>
        <ul className="move-explain" style={{ marginTop: 0 }}>{review.summary.map((s, i) => <li key={i}>{s}</li>)}</ul>
      </div>
    </div>
  );
}
