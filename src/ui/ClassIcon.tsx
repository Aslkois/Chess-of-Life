import { CLASS_INFO, type Classification } from '../analysis/classify';

/**
 * Move-classification mark. One drawing used everywhere, scaled per context:
 *   xs 16px – move lists and tree      md 28px – review/coach cards
 *   sm 20px – compact tables           board – sized from the square (≈42%)
 * Each class has both a colour and a distinct shape/glyph, so it never relies
 * on colour alone. A thin dark ring keeps it legible over pieces and squares.
 */
export type IconSize = 'xs' | 'sm' | 'md' | 'lg' | number;
const PX: Record<Exclude<IconSize, number>, number> = { xs: 16, sm: 20, md: 28, lg: 40 };

const COLOR_VAR: Record<Classification, string> = {
  brilliant: 'var(--c-brilliant)', great: 'var(--c-great)', best: 'var(--c-best)', excellent: 'var(--c-excellent)', good: 'var(--c-good)',
  book: 'var(--c-book)', inaccuracy: 'var(--c-inaccuracy)', mistake: 'var(--c-mistake)', miss: 'var(--c-miss)', blunder: 'var(--c-blunder)',
};

const INK = '#101410';

function Glyph({ cls }: { cls: Classification }) {
  const text = (t: string, size: number, dx = 0) => (
    <text x={12 + dx} y={12} textAnchor="middle" dominantBaseline="central" fontFamily="var(--font-display), system-ui, sans-serif" fontWeight={800} fontSize={size} fill="#fff" letterSpacing={-0.6}>{t}</text>
  );
  switch (cls) {
    case 'brilliant': return text('!!', 12.5);
    case 'great': return text('!', 14);
    case 'inaccuracy': return text('?!', 11.5);
    case 'mistake': return text('?', 14);
    case 'blunder': return text('??', 12);
    case 'best': return <path d="m12 5.6 1.95 3.95 4.35.63-3.15 3.07.74 4.33L12 15.53l-3.89 2.05.74-4.33L5.7 10.18l4.35-.63z" fill="#fff" />;
    case 'excellent': return <path d="m7.2 12.4 3.2 3.2 6.4-6.8" fill="none" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />;
    case 'good': return <circle cx="12" cy="12" r="3.2" fill="#fff" />;
    case 'book': return <path d="M12 8.2c-1.6-1.1-3.5-1.4-5.3-1.2v9c1.8-.2 3.7.1 5.3 1.2 1.6-1.1 3.5-1.4 5.3-1.2v-9c-1.8-.2-3.7.1-5.3 1.2zM12 8.2v9" fill="none" stroke="#fff" strokeWidth={1.7} strokeLinejoin="round" />;
    case 'miss': return <path d="M8.3 8.3l7.4 7.4M15.7 8.3l-7.4 7.4" stroke="#fff" strokeWidth={2.6} strokeLinecap="round" />;
  }
}

export function ClassIcon({ cls, size = 'xs', provisional, title, decorative }: { cls: Classification; size?: IconSize; provisional?: boolean; title?: string; decorative?: boolean }) {
  const px = typeof size === 'number' ? size : PX[size];
  const label = `${CLASS_INFO[cls].label}${provisional ? ' (provisional)' : ''}`;
  return (
    <svg
      className={`cls-icon${provisional ? ' is-provisional' : ''}`}
      width={px} height={px} viewBox="0 0 24 24"
      role={decorative ? undefined : 'img'} aria-hidden={decorative ? true : undefined} aria-label={decorative ? undefined : label}
      data-cls={cls}
    >
      {!decorative && <title>{title ?? label}</title>}
      <circle cx="12" cy="12" r="11" fill={COLOR_VAR[cls]} stroke={INK} strokeWidth={1.4} />
      {provisional && <circle cx="12" cy="12" r="8.9" fill="none" stroke="#fff" strokeWidth={1} strokeDasharray="2 2.2" opacity={0.75} />}
      <Glyph cls={cls} />
    </svg>
  );
}

/** Pending placeholder shown while a move is being analysed. */
export function PendingIcon({ size = 'xs' }: { size?: IconSize }) {
  const px = typeof size === 'number' ? size : PX[size];
  return (
    <svg className="cls-icon" width={px} height={px} viewBox="0 0 24 24" role="img" aria-label="Analysing">
      <title>Analysing…</title>
      <circle cx="12" cy="12" r="10" fill="none" stroke="var(--text-3)" strokeWidth={2} strokeDasharray="3 3" />
    </svg>
  );
}

export const classColor = (cls: Classification) => COLOR_VAR[cls];
