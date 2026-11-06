/**
 * Central assistance policy. Every assistive UI element asks this module
 * whether it may appear. Active Ranked games allow none of them.
 */
export type Mode = 'reconstruct' | 'review' | 'coach' | 'ranked-active' | 'ranked-finished';

export type Assist =
  | 'evalBar' | 'evalGraph' | 'classifications' | 'engineLines' | 'bestMoveArrows'
  | 'hints' | 'takeback' | 'prediction' | 'coachFeedback' | 'branches' | 'explanations';

export const ALL_ASSISTS: Assist[] = ['evalBar', 'evalGraph', 'classifications', 'engineLines', 'bestMoveArrows', 'hints', 'takeback', 'prediction', 'coachFeedback', 'branches', 'explanations'];

const POLICY: Record<Mode, Assist[]> = {
  reconstruct: [],
  review: ['evalBar', 'evalGraph', 'classifications', 'engineLines', 'bestMoveArrows', 'branches', 'explanations'],
  // the Coach shows classifications and conceptual feedback, never engine moves
  coach: ['classifications', 'hints', 'takeback', 'prediction', 'coachFeedback'],
  'ranked-active': [],
  'ranked-finished': ['evalBar', 'evalGraph', 'classifications', 'engineLines', 'bestMoveArrows', 'branches', 'explanations'],
};

export function allowed(mode: Mode, a: Assist): boolean {
  return POLICY[mode].includes(a);
}
