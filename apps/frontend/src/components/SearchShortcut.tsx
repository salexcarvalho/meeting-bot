import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";
import { SEARCH_INPUT_ID } from "./SearchBox";

export const SEARCH_PATH = "/busca";

/** Ctrl+K (ou Cmd+K) abre a busca e põe o foco no campo. Só age nesse atalho exato; o resto do navegador segue normal. */
export function SearchShortcut() {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isShortcut = e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (!isShortcut) return;
      e.preventDefault();
      const field = document.getElementById(SEARCH_INPUT_ID);
      if (location.pathname === SEARCH_PATH && field instanceof HTMLInputElement) {
        field.focus();
        field.select();
        return;
      }
      // Em /busca na aba Perguntar o campo não existe: volta à aba Buscar mantendo a consulta.
      const params = new URLSearchParams(location.pathname === SEARCH_PATH ? location.search : "");
      params.delete("tab");
      const query = params.toString();
      navigate({ pathname: SEARCH_PATH, search: query ? `?${query}` : "" }, { state: { focusSearch: Date.now() } });
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, location.pathname, location.search]);

  return null;
}
