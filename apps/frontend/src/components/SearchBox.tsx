import type { FormEvent, RefObject } from "react";
import { Search } from "lucide-react";
import { SEARCH_QUERY_MAX } from "@meeting-bot/contracts";

export const SEARCH_INPUT_ID = "busca-campo";

export function SearchBox({
  value,
  onChange,
  onSubmit,
  busy,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (value.trim()) onSubmit();
  }
  return (
    <form className="search-box" role="search" onSubmit={submit}>
      <label className="sr-only" htmlFor={SEARCH_INPUT_ID}>Buscar nas reuniões</label>
      <input
        ref={inputRef}
        id={SEARCH_INPUT_ID}
        type="search"
        value={value}
        maxLength={SEARCH_QUERY_MAX}
        placeholder="Buscar em transcrições, atas, itens e ADRs (Ctrl+K)"
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="submit" className="primary" disabled={busy || !value.trim()}>
        <Search aria-hidden="true" /> {busy ? "Buscando…" : "Buscar"}
      </button>
    </form>
  );
}
