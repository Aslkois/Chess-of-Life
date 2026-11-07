import { CLASS_INFO, type Classification } from '../analysis/classify';
import { barFraction, formatScore, winPercent, type Score } from '../engine/score';
import { capturedPieces, materialCount } from '../chess/rules';
import { formatClock } from '../chess/clock';

export function ClassBadge({ cls, provisional, title }: { cls: Classification | null | undefined; provisional?: boolean; title?: string }) {
  if (!cls) return <span className="badge" style={{ background: '#3a4146', color: '#bbb' }} title="Analysing…">…</span>;
  const i = CLASS_INFO[cls];
  return (
    <span className={`badge${provisional ? ' prov' : ''}`} style={{ background: i.color }} title={`${title ?? i.label}${provisional ? ' (provisional – deeper analysis pending)' : ''}`} aria-label={`${i.label}${provisional ? ' provisional' : ''}`} data-cls={cls}>
      {i.symbol}
    </span>
  );
}

export function EvalBar({ score, orientation }: { score?: Score; orientation: 'white' | 'black' }) {
  const f = barFraction(score);
  const text = formatScore(score).replace('+', '');
  const whiteAhead = score ? winPercent(score) >= 50 : true;
  const whiteAtBottom = orientation === 'white';
  const labelAtBottom = whiteAhead === whiteAtBottom;
  return (
    <div className="evalbar" data-testid="evalbar" aria-label={`Evaluation ${formatScore(score)}`} title={`Evaluation ${formatScore(score)} (White's view)`}>
      <div className="white" style={{ height: `${f * 100}%`, ...(whiteAtBottom ? { bottom: 0 } : { top: 0, bottom: 'auto' }) }} />
      <div className={`label ${labelAtBottom ? 'bottom' : 'top'}`} style={{ color: whiteAhead ? '#111' : '#ddd' }}>{text}</div>
    </div>
  );
}

const GLYPH: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' };

export function PlayerBar({ name, color, fen, clockMs, running, sub }: { name: string; color: 'w' | 'b'; fen: string; clockMs?: number; running?: boolean; sub?: string }) {
  const cap = capturedPieces(fen);
  const mine = color === 'w' ? cap.byWhite : cap.byBlack;
  const mat = materialCount(fen);
  const adv = color === 'w' ? mat.diff : -mat.diff;
  return (
    <div className="player-bar" data-testid={`player-${color}`}>
      <span className="swatch" style={{ background: color === 'w' ? '#e8ebe6' : '#1c2125' }} aria-label={color === 'w' ? 'White' : 'Black'} />
      <span className="name">{name}</span>
      {sub && <span className="faint small">{sub}</span>}
      <span className="captured" aria-label="captured pieces">{mine.map((p) => GLYPH[p]).join('')}</span>
      {adv > 0 && <span className="adv">+{adv}</span>}
      {clockMs !== undefined && isFinite(clockMs) && (
        <span className={`clock${running ? ' running' : ''}${clockMs < 20000 ? ' low' : ''}`} data-testid={`clock-${color}`}>{formatClock(clockMs)}</span>
      )}
    </div>
  );
}

export function Meter({ value, lo, hi }: { value: number; lo?: number; hi?: number }) {
  return (
    <div className="meter" aria-valuenow={Math.round(value * 100)} role="meter">
      {lo !== undefined && hi !== undefined && <i className="ci" style={{ left: `${lo * 100}%`, width: `${(hi - lo) * 100}%` }} />}
      <i style={{ width: `${value * 100}%`, opacity: 0.9 }} />
    </div>
  );
}

export function Modal({ children, onClose }: { children: React.ReactNode; onClose?: () => void }) {
  return (
    <div className="modal-back" onClick={onClose} role="dialog">
      <div className="card modal" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

export function downloadText(name: string, text: string, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
