import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { NavGroup } from "./nav";
import { Brand, NavList, UserBox, type ShellUser } from "./Sidebar";

// Menu lateral para telas < 1024px. Fecha com Esc, clique fora ou ao navegar.
export function MobileDrawer({
  open,
  onClose,
  groups,
  user,
  onPassword,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  groups: NavGroup[];
  user: ShellUser;
  onPassword: () => void;
  onLogout: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="drawer" role="dialog" aria-modal="true" aria-label="Menu">
      <button type="button" className="drawer-overlay" aria-label="Fechar menu" tabIndex={-1} onClick={onClose} />
      <div className="drawer-panel">
        <div className="drawer-head">
          <Brand onNavigate={onClose} />
          <button ref={closeRef} type="button" className="ghost icon small" aria-label="Fechar menu" onClick={onClose}>
            <X />
          </button>
        </div>
        <div className="grow">
          <NavList groups={groups} onNavigate={onClose} />
        </div>
        <UserBox
          user={user}
          onPassword={() => {
            onClose();
            onPassword();
          }}
          onLogout={onLogout}
        />
      </div>
    </div>
  );
}
