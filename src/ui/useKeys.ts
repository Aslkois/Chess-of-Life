import { useEffect, useRef } from 'react';

/**
 * Page-level keyboard shortcuts. Ignored while typing in a field or when a
 * dialog is open, so they never fight with text entry or modal focus.
 */
export function useKeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('dialog[open]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = (e.shiftKey && e.key.length > 1 ? 'Shift+' : '') + e.key;
      const fn = ref.current[key] ?? ref.current[e.key];
      if (fn) { e.preventDefault(); fn(e); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [enabled]);
}

export function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.motion === 'reduced') return true;
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
