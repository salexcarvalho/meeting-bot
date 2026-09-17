import { useCallback, useEffect, useState } from "react";

// Mesma chave do script inline em index.html (aplica o tema antes do React montar).
export const THEME_KEY = "agente-theme";

export type Theme = "light" | "dark";

function storedTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Sem escolha salva, o tema segue o sistema (o CSS usa prefers-color-scheme).
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [choice, setChoice] = useState<Theme | null>(storedTheme);
  const [system, setSystem] = useState<Theme>(systemTheme);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = () => setSystem(media.matches ? "dark" : "light");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (choice) root.dataset.theme = choice;
    else delete root.dataset.theme;
  }, [choice]);

  const theme = choice ?? system;

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setChoice(next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      // armazenamento bloqueado: a escolha vale só nesta aba
    }
  }, [theme]);

  return { theme, toggle };
}
