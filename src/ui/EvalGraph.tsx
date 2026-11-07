import { CLASS_INFO, type Classification } from '../analysis/classify';
import { winPercent, type Score } from '../engine/score';

const MARKED: Classification[] = ['brilliant', 'great', 'miss', 'mistake', 'blunder'];

/** White's winning chances across the game. Click to jump; notable moves are marked. */
export function EvalGraph({ scores, current, onSelect, marks, height = 72 }: { scores: (Score | undefined)[]; current: number; onSelect?: (i: number) => void; marks?: (Classification | undefined)[]; height?: number }) {
  const W = 600;
  const H = 100;
  const n = Math.max(scores.length - 1, 1);
  const x = (i: number) => (i / n) * W;
  const y = (s?: Score) => H - (s ? winPercent(s) / 100 : 0.5) * H;
  const pts = scores.map((s, i) => `${x(i).toFixed(1)},${y(s).toFixed(1)}`).join(' ');
  return (
    <svg className="graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height }} data-testid="evalgraph" role="img" aria-label="Winning chances over the game; click to jump to a move"
      onClick={(e) => {
        const r = (e.currentTarget as SVGElement).getBoundingClientRect();
        onSelect?.(Math.max(0, Math.min(scores.length - 1, Math.round(((e.clientX - r.left) / r.width) * n))));
      }}>
      <rect x="0" y="0" width={W} height={H} fill="#262d2a" />
      <polygon points={`0,${H} ${pts} ${W},${H}`} fill="#e9e5d8" />
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="#7d8680" strokeWidth="1" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
      {current >= 0 && <>
        <line x1={x(current)} x2={x(current)} y1="0" y2={H} stroke="#0e1412" strokeWidth="4" vectorEffect="non-scaling-stroke" />
        <line x1={x(current)} x2={x(current)} y1="0" y2={H} stroke="#ede7d5" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </>}
      {marks?.map((c, i) => (c && MARKED.includes(c) ? <circle key={i} cx={x(i + 1)} cy={y(scores[i + 1])} r="4.5" fill={CLASS_INFO[c].color} stroke="#0e1412" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /> : null))}
    </svg>
  );
}
