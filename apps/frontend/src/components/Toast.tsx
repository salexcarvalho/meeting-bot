import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

type ShowToast = (message: string, kind?: "info" | "error") => void;
const ToastContext = createContext<ShowToast>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ message: string; kind: string } | null>(null);
  const timer = useRef<number | null>(null);
  const show = useCallback<ShowToast>((message, kind = "info") => {
    setToast({ message, kind });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {toast && (
        <div className={`toast ${toast.kind === "error" ? "error" : ""}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      )}
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
