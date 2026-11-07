import { useEffect, useId, useRef, type ReactNode } from 'react';
import { IconClose } from './icons';

/**
 * Modal dialog on the native <dialog> element: it sits in the top layer,
 * makes the rest of the page inert, contains Tab focus and closes on Escape.
 * Focus returns to whatever was focused before it opened.
 */
export function Dialog({ open, onClose, title, description, children, footer, wide, testId }: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      el.showModal();
      // showModal() focuses the first focusable element (the close button);
      // move focus to the element the dialog marks as its starting point.
      const start = el.querySelector<HTMLElement>('[data-autofocus]');
      start?.focus();
    } else if (!open && el.open) {
      el.close();
      returnTo.current?.focus?.();
    }
  }, [open]);

  useEffect(() => () => { if (ref.current?.open) returnTo.current?.focus?.(); }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? ' dialog-wide' : ''}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      data-testid={testId}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {open && (
        <>
          <div className="dialog-head">
            <div style={{ minWidth: 0 }}>
              <h2 id={titleId}>{title}</h2>
              {description && <p id={descId}>{description}</p>}
            </div>
            <button type="button" className="btn btn-quiet btn-icon dialog-close" onClick={onClose} aria-label="Close dialog"><IconClose /></button>
          </div>
          {children && <div className="dialog-body">{children}</div>}
          {footer && <div className="dialog-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

/**
 * Confirmation for consequential actions. Buttons state the action in words
 * ("Delete branch" / "Keep branch"); the safe choice gets initial focus.
 * Mark any other dialog's starting element with `data-autofocus`.
 */
export function ConfirmDialog({ open, title, body, confirmLabel, cancelLabel, danger, onConfirm, onCancel, testId }: {
  open: boolean; title: string; body?: ReactNode; confirmLabel: string; cancelLabel: string; danger?: boolean;
  onConfirm: () => void; onCancel: () => void; testId?: string;
}) {
  return (
    <Dialog open={open} onClose={onCancel} title={title} description={body} testId={testId}
      footer={<>
        <button type="button" className="btn" onClick={onCancel} data-autofocus>{cancelLabel}</button>
        <button type="button" className={`btn ${danger ? 'btn-danger-solid' : 'btn-primary'}`} onClick={onConfirm} data-testid={testId ? `${testId}-confirm` : undefined}>{confirmLabel}</button>
      </>}
    />
  );
}
