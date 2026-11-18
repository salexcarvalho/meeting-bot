import { SEARCH_KIND_LABELS, SEARCH_KINDS, SEARCH_MODES } from "@meeting-bot/contracts";
import type { Project, SearchKindValue, SearchModeValue } from "@meeting-bot/contracts";
import { MODE_LABELS } from "../searchUi";

export interface SearchFilterValues {
  mode: SearchModeValue;
  kinds: SearchKindValue[];
  projectId: string;
  from: string;
  to: string;
}

export const EMPTY_FILTERS: SearchFilterValues = { mode: "hybrid", kinds: [], projectId: "", from: "", to: "" };

export function hasActiveFilters(f: SearchFilterValues): boolean {
  return f.mode !== EMPTY_FILTERS.mode || f.kinds.length > 0 || Boolean(f.projectId || f.from || f.to);
}

export function invalidPeriod(f: SearchFilterValues): boolean {
  return Boolean(f.from && f.to && f.from > f.to);
}

export function SearchFilters({
  values,
  projects,
  onChange,
}: {
  values: SearchFilterValues;
  projects: Project[];
  onChange: (patch: Partial<SearchFilterValues>) => void;
}) {
  const toggleKind = (kind: SearchKindValue) =>
    onChange({ kinds: values.kinds.includes(kind) ? values.kinds.filter((k) => k !== kind) : [...values.kinds, kind] });
  const periodInvalid = invalidPeriod(values);
  return (
    <div className="search-filters">
      <div className="search-filters-grid">
        <label>
          Projeto
          <select value={values.projectId} onChange={(e) => onChange({ projectId: e.target.value })}>
            <option value="">Todos os projetos</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label>
          De
          <input type="date" value={values.from} max={values.to || undefined} onChange={(e) => onChange({ from: e.target.value })} />
        </label>
        <label>
          Até
          <input
            type="date"
            value={values.to}
            min={values.from || undefined}
            aria-invalid={periodInvalid}
            onChange={(e) => onChange({ to: e.target.value })}
          />
        </label>
        <label>
          Modo
          <select value={values.mode} onChange={(e) => onChange({ mode: e.target.value as SearchModeValue })}>
            {SEARCH_MODES.map((m) => (
              <option key={m} value={m}>{MODE_LABELS[m]}</option>
            ))}
          </select>
        </label>
      </div>
      {periodInvalid && <p className="error-text small" role="alert">A data inicial é depois da final.</p>}
      <fieldset className="search-kinds">
        <legend className="small muted">Tipo de conteúdo (nada marcado = todos)</legend>
        <div className="row">
          {SEARCH_KINDS.map((kind) => (
            <label key={kind} className="search-kind">
              <input type="checkbox" checked={values.kinds.includes(kind)} onChange={() => toggleKind(kind)} />
              {SEARCH_KIND_LABELS[kind]}
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
