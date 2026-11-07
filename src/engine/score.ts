/**
 * Engine score, always normalised to White's point of view.
 * cp or mate is set (or `mated` for a terminal checkmate). mate > 0 = White mates in N moves, mate < 0 = Black mates in N.
 */
export interface Score {
  cp?: number;
  mate?: number;
  /** set when the side to move is already checkmated (terminal position) */
  mated?: 'w' | 'b';
}

/** UCI reports scores from the side to move. Convert to White's perspective. */
export function normalizeScore(raw: { cp?: number; mate?: number }, sideToMove: 'w' | 'b'): Score {
  const sign = sideToMove === 'w' ? 1 : -1;
  if (raw.mate !== undefined) {
    if (raw.mate === 0) return { mated: sideToMove };
    return { mate: raw.mate * sign };
  }
  return { cp: (raw.cp ?? 0) * sign };
}

/** Terminal score for a position where the side to move is checkmated. */
export function matedScore(sideToMove: 'w' | 'b'): Score {
  return { mated: sideToMove };
}

/** Score of a drawn terminal position (stalemate, dead position...). */
export const DRAW_SCORE: Score = { cp: 0 };

const MATE_CP = 100000;

/**
 * Convert a score to a single comparable centipawn number (White POV).
 * Mates map to ±(MATE_CP - plies) so faster mates rank higher.
 */
export function toCp(s: Score): number {
  if (s.mated) return s.mated === 'w' ? -MATE_CP : MATE_CP;
  if (s.mate !== undefined) {
    return s.mate > 0 ? MATE_CP - s.mate * 10 : -MATE_CP - s.mate * 10;
  }
  return s.cp ?? 0;
}

/** Score from the perspective of `color`. */
export function isMateScore(s: Score): boolean {
  return s.mated !== undefined || s.mate !== undefined;
}

export function povCp(s: Score, color: 'w' | 'b'): number {
  return color === 'w' ? toCp(s) : -toCp(s);
}

/**
 * Winning chances for White in [0,100] from a score.
 * Logistic model fitted on large human game databases (published by Lichess):
 * win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * cp)) - 1), cp clamped to ±1000.
 */
export function winPercent(s: Score): number {
  if (s.mated || s.mate !== undefined) return toCp(s) > 0 ? 100 : 0;
  const cp = Math.max(-1000, Math.min(1000, s.cp ?? 0));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * cp)) - 1);
}

export function winPercentPov(s: Score, color: 'w' | 'b'): number {
  const w = winPercent(s);
  return color === 'w' ? w : 100 - w;
}

export function formatScore(s: Score | undefined): string {
  if (!s) return '…';
  if (s.mated) return s.mated === 'w' ? '0-1#' : '1-0#';
  if (s.mate !== undefined) {
    return `${s.mate > 0 ? '' : '-'}M${Math.abs(s.mate)}`;
  }
  const v = (s.cp ?? 0) / 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
}

/** Eval-bar fill for White in [0,1]. */
export function barFraction(s: Score | undefined): number {
  if (!s) return 0.5;
  return winPercent(s) / 100;
}
