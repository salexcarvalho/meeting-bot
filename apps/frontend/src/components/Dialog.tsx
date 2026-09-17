import { useEffect, useRef, type ReactNode } from "react";

// <dialog> nativo controlado por estado (sem window.confirm/alert).
export function Dialog({ open, onClose, children, label }: { open: boolean; onClose: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-label={label} onClose={onClose} onCancel={onClose}>
      {open && children}
    </dialog>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} label={title}>
      <h2>{title}</h2>
      <div className="muted" style={{ marginBottom: 16 }}>{message}</div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>Cancelar</button>
        <button
          type="button"
          className={danger ? "danger solid" : "primary"}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
