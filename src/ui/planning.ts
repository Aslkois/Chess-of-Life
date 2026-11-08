import { useSyncExternalStore } from 'react';

/**
 * Planning annotations drawn by the user: arrows and marked squares. They are
 * the user's own notes and never come from the engine.
 */
export interface PlanArrow { from: string; to: string; color: string }
export interface PlanMark { sq: string; color: string }
export interface Annotations { arrows: PlanArrow[]; marks: PlanMark[] }
export const EMPTY_ANNOTATIONS: Annotations = { arrows: [], marks: [] };

/** Planning colours: orange by default; Shift green, Alt blue, Ctrl/Cmd red. */
export const PLAN_COLORS = { orange: '#f2a33a', green: '#5fb944', blue: '#4f8ef0', red: '#e5534b' } as const;
export function planColor(m: { shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }): string {
  if (m.ctrlKey || m.metaKey) return PLAN_COLORS.red;
  if (m.altKey) return PLAN_COLORS.blue;
  if (m.shiftKey) return PLAN_COLORS.green;
  return PLAN_COLORS.orange;
}

/** Drawing the same arrow again removes it; the same squares in a new colour recolour it. */
export function toggleArrow(a: Annotations, from: string, to: string, color: string): Annotations {
  const i = a.arrows.findIndex((x) => x.from === from && x.to === to);
  if (i >= 0 && a.arrows[i].color === color) return { ...a, arrows: a.arrows.filter((_, j) => j !== i) };
  if (i >= 0) return { ...a, arrows: a.arrows.map((x, j) => (j === i ? { ...x, color } : x)) };
  return { ...a, arrows: [...a.arrows, { from, to, color }] };
}

export function toggleMark(a: Annotations, sq: string, color: string): Annotations {
  const i = a.marks.findIndex((x) => x.sq === sq);
  if (i >= 0 && a.marks[i].color === color) return { ...a, marks: a.marks.filter((_, j) => j !== i) };
  if (i >= 0) return { ...a, marks: a.marks.map((x, j) => (j === i ? { ...x, color } : x)) };
  return { ...a, marks: [...a.marks, { sq, color }] };
}

export const hasAnnotations = (a: Annotations) => a.arrows.length > 0 || a.marks.length > 0;

/** The square under a point of the board (x, y relative to its top-left corner). */
export function squareAt(x: number, y: number, size: number, orientation: 'white' | 'black'): string | null {
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  const col = Math.floor((x / size) * 8);
  const row = Math.floor((y / size) * 8);
  const file = orientation === 'white' ? col : 7 - col;
  const rank = orientation === 'white' ? 7 - row : row;
  return 'abcdefgh'[file] + String(rank + 1);
}

// ---------------- touch "plan mode" (shared across boards) ----------------

let planMode = false;
const listeners = new Set<() => void>();
export function setPlanMode(on: boolean) { planMode = on; listeners.forEach((l) => l()); }
export function usePlanMode(): boolean {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => planMode, () => false);
}
