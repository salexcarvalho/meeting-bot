import { AudioLines, Menu, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { useTheme } from "../../theme";

export function Header({ onMenu, menuOpen, children }: { onMenu: () => void; menuOpen: boolean; children?: ReactNode }) {
  const { theme, toggle } = useTheme();
  const dark = theme === "dark";
  return (
    <header className="app-header">
      <button
        type="button"
        className="ghost icon small only-mobile"
        aria-label="Abrir menu"
        aria-expanded={menuOpen}
        onClick={onMenu}
      >
        <Menu />
      </button>
      <span className="app-header-brand" aria-hidden="true" style={{ color: "var(--primary)" }}>
        <AudioLines size={20} />
      </span>
      <div className="app-header-slot">{children}</div>
      <button
        type="button"
        className="ghost icon small"
        aria-label={dark ? "Usar tema claro" : "Usar tema escuro"}
        title={dark ? "Tema claro" : "Tema escuro"}
        onClick={toggle}
      >
        {dark ? <Sun /> : <Moon />}
      </button>
    </header>
  );
}
