/** Small inline icon set (original, stroke-based). */
const P = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const I = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...P}><path d={d} /></svg>
);
export const IconHome = () => <I d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" />;
export const IconBoard = () => <I d="M4 4h16v16H4zM4 12h16M12 4v16M8 4v4h4M12 12v4h4M16 4v4M4 16h4v4" />;
export const IconImport = () => <I d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v3h16v-3" />;
export const IconLibrary = () => <I d="M4 5h4v15H4zM10 5h4v15h-4zM16 6l3.5-1 3 14-3.5 1z" />;
export const IconTree = () => <I d="M12 21v-8m0 0l-5-4m5 4l5-5M7 9V5m0 4l-3-2m13-1V3m0 3l3-1" />;
export const IconCoach = () => <I d="M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM5 21c0-4 3-7 7-7s7 3 7 7M17 4l2-1M19 8h2" />;
export const IconSword = () => <I d="M14.5 3H21v6.5L10 20l-3-3zM5 15l4 4M3 21l3-3" />;
export const IconProfile = () => <I d="M4 20V10M10 20V4M16 20v-7M22 20H2" />;
export const IconSettings = () => <I d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />;
export const IconFlip = () => <I d="M7 4v16m0 0l-3-3m3 3l3-3M17 20V4m0 0l-3 3m3-3l3 3" />;
export const IconFirst = () => <I d="M18 6l-6 6 6 6M7 5v14" />;
export const IconPrev = () => <I d="M15 6l-6 6 6 6" />;
export const IconNext = () => <I d="M9 6l6 6-6 6" />;
export const IconLast = () => <I d="M6 6l6 6-6 6M17 5v14" />;
export const IconLock = () => <I d="M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3" />;
export const IconMenu = () => <I d="M4 7h16M4 12h16M4 17h16" />;
