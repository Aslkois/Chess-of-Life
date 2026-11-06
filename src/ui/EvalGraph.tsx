import { CLASS_INFO, type Classification } from '../analysis/classify';
import { winPercent, type Score } from '../engine/score';

/** Winning-chance graph (White's view) for every position of the game. */
export function EvalGraph({ scores, current, onSelect, marks }: { scores: (Score | undefined)[]; current: number; onSelect?: (i: number) => void; marks?: (Classification | undefined)[] }) {
  const W = 600;
  const H = 110;
  const n = Math.max(scores.length - 1, 1);
  const x = (i: number) => (i / n) * W;
  const y = (s?: Score) => H - (s ? winPercent(s) / 100 : 0.5) * H;
  const pts = scores.map((s, i) => `${x(i).toFixed(1)},${y(s).toFixed(1)}`).join(' ');
  const area = `0,${H} ${pts} ${W},${H}`;
  return (
    <svg className="graph" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" data-testid="evalgraph"
      onClick={(e) => {
        const r = (e.currentTarget as SVGElement).getBoundingClientRect();
        const i = Math.round(((e.clientX - r.left) / r.width) * n);
        onSelect?.(Math.max(0, Math.min(scores.length - 1, i)));
      }}>
      <rect x="0" y="0" width={W} height={H} fill="#22272b" />
      <polygon points={area} fill="#dfe3dc" />
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} stroke="#7c8682" strokeWidth="1" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      {marks?.map((c, i) => {
        if (!c || !['blunder', 'mistake', 'miss', 'brilliant', 'great'].includes(c)) return null;
        return <circle key={i} cx={x(i + 1)} cy={y(scores[i + 1])} r="4" fill={CLASS_INFO[c].color} stroke="#000" strokeWidth="1" vectorEffect="non-scaling-stroke" />;
      })}
      <line x1={x(current)} x2={x(current)} y1="0" y2={H} stroke="#8fc17a" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
