/**
 * Central assistance policy. Every assistive UI element asks this module
 * whether it may appear. Active Ranked games allow none of them.
 */
export type Mode = 'reconstruct' | 'review' | 'coach' | 'ranked-active' | 'ranked-finished';

export type Assist =
  | 'evalBar' | 'evalGraph' | 'classifications' | 'engineLines' | 'bestMoveArrows'
  | 'hints' | 'takeback' | 'prediction' | 'coachFeedback' | 'branches' | 'explanations'
  /** post-move demonstrations: Show Why, Best Move, Compare */
  | 'demonstrations'
  /** opening names, book status and the Opening Explorer */
  | 'openingInfo';

export const ALL_ASSISTS: Assist[] = ['evalBar', 'evalGraph', 'classifications', 'engineLines', 'bestMoveArrows', 'hints', 'takeback', 'prediction', 'coachFeedback', 'branches', 'explanations', 'demonstrations', 'openingInfo'];

const POLICY: Record<Mode, Assist[]> = {
  reconstruct: [],
  review: ['evalBar', 'evalGraph', 'classifications', 'engineLines', 'bestMoveArrows', 'branches', 'explanations', 'demonstrations', 'openingInfo'],
  // The Coach rates moves and explains them after they are played. Before a
  // move it only gives conceptual hints, never the engine's move; the better
  // move is shown only after the player's decision, and only on request.
  coach: ['classifications', 'hints', 'takeback', 'prediction', 'coachFeedback', 'explanations', 'demonstrations', 'openingInfo'],
  'ranked-active': [],
  'ranked-finished': ['evalBar', 'evalGraph', 'classifications', 'engineLines', 'bestMoveArrows', 'branches', 'explanations', 'demonstrations', 'openingInfo'],
};

export function allowed(mode: Mode, a: Assist): boolean {
  return POLICY[mode].includes(a);
}
