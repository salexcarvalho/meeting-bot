import { Link } from "react-router";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

export interface ToastAction {
  label: string;
  to: string;
}

type ShowToast = (message: string, kind?: "info" | "error", action?: ToastAction) => void;
const ToastContext = createContext<ShowToast>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; kind: string; action?: ToastAction } | null>(null);
  const timer = useRef<number | null>(null);
  const show = useCallback<ShowToast>((message, kind = "info", action) => {
    setToast({ message, kind, action });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast ${toast.kind === "error" ? "error" : ""}`} role="status" aria-live="polite">
          {toast.message}
          {toast.action && (
            <Link className="toast-action" to={toast.action.to} onClick={() => setToast(null)}>
              {toast.action.label}
            </Link>
          )}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
