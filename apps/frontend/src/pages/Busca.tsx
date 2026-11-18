import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router";
import { SearchX, Search as SearchIcon } from "lucide-react";
import {
  SEARCH_KINDS,
  SEARCH_MAX_OFFSET,
  SEARCH_MODES,
  type SearchHitValue,
  type SearchKindValue,
  type SearchModeValue,
  type SearchResponseValue,
  type SearchStatusValue,
} from "@meeting-bot/contracts";
import { ApiError, errorMessage, ignoreError, search, searchStatus, type SearchParams } from "../api";
import { ChatPanel } from "../components/ChatPanel";
import { SearchBox } from "../components/SearchBox";
import {
  EMPTY_FILTERS,
  hasActiveFilters,
  invalidPeriod,
  SearchFilters,
  type SearchFilterValues,
} from "../components/SearchFilters";
import { SearchResultList } from "../components/SearchResult";
import { EmptyState, PageHeader, SkeletonLines } from "../components/ui";
import { useProjects } from "../hooks";
import { chatUnavailableText, semanticReasonText } from "../searchUi";

const TAB_SEARCH = "buscar";
const TAB_ASK = "perguntar";
type Tab = typeof TAB_SEARCH | typeof TAB_ASK;
const TABS: { key: Tab; label: string }[] = [
  { key: TAB_SEARCH, label: "Buscar" },
  { key: TAB_ASK, label: "Perguntar" },
];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// ---------- estado na URL: /busca?q=&mode=&kind=a,b&projectId=&from=&to=&tab=perguntar ----------

function dateParam(params: URLSearchParams, key: string): string {
  const value = params.get(key) ?? "";
  return DATE_PATTERN.test(value) ? value : "";
}

function parseFilters(params: URLSearchParams): SearchFilterValues {
  const mode = params.get("mode");
  const kinds = (params.get("kind") ?? "").split(",").filter((k): k is SearchKindValue => SEARCH_KINDS.some((s) => s === k));
  return {
    mode: SEARCH_MODES.find((m) => m === mode) ?? EMPTY_FILTERS.mode,
    kinds,
    projectId: params.get("projectId") ?? "",
    from: dateParam(params, "from"),
    to: dateParam(params, "to"),
  };
}

function buildParams(q: string, filters: SearchFilterValues, tab: Tab): URLSearchParams {
  const entries: [string, string][] = [
    ["q", q],
    ["mode", filters.mode === EMPTY_FILTERS.mode ? "" : filters.mode],
    ["kind", filters.kinds.join(",")],
    ["projectId", filters.projectId],
    ["from", filters.from],
    ["to", filters.to],
    ["tab", tab === TAB_ASK ? TAB_ASK : ""],
  ];
  const next = new URLSearchParams();
  for (const [key, value] of entries) if (value) next.set(key, value);
  return next;
}

// ---------- estado do índice (habilitação da busca e do chat) ----------

interface IndexState {
  status: SearchStatusValue | null;
  disabled: boolean;
}

function useIndexStatus(): IndexState {
  const [state, setState] = useState<IndexState>({ status: null, disabled: false });
  useEffect(() => {
    searchStatus()
      .then((status) => setState({ status, disabled: !status.enabled }))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setState({ status: null, disabled: true });
        else ignoreError();
      });
  }, []);
  return state;
}

// ---------- resultados ----------

interface ResultsState {
  response: SearchResponseValue | null;
  hits: SearchHitValue[];
  loading: boolean;
  loadingMore: boolean;
  error: string;
}

const IDLE_RESULTS: ResultsState = { response: null, hits: [], loading: false, loadingMore: false, error: "" };

function mergeHits(current: SearchHitValue[], incoming: SearchHitValue[]): SearchHitValue[] {
  const known = new Set(current.map((h) => h.id));
  return [...current, ...incoming.filter((h) => !known.has(h.id))];
}

function searchRequest(q: string, mode: SearchModeValue, kindKey: string, projectId: string, from: string, to: string): SearchParams {
  return {
    q,
    mode,
    kind: kindKey ? (kindKey.split(",") as SearchKindValue[]) : undefined,
    projectId: projectId || undefined,
    from: from || undefined,
    to: to || undefined,
  };
}

function useSearchResults(q: string, filters: SearchFilterValues, refresh: number) {
  const [state, setState] = useState<ResultsState>(IDLE_RESULTS);
  const stateRef = useRef(state);
  stateRef.current = state;
  const moreController = useRef<AbortController | null>(null);
  const { mode, projectId, from, to } = filters;
  const kindKey = filters.kinds.join(",");
  const periodInvalid = invalidPeriod(filters);

  useEffect(() => {
    moreController.current?.abort();
    if (!q || periodInvalid) {
      setState(IDLE_RESULTS);
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ ...s, loading: true, loadingMore: false, error: "" }));
    search(searchRequest(q, mode, kindKey, projectId, from, to), controller.signal)
      .then((response) => setState({ response, hits: response.hits, loading: false, loadingMore: false, error: "" }))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setState({ ...IDLE_RESULTS, error: errorMessage(err) });
      });
    return () => controller.abort();
  }, [q, mode, kindKey, projectId, from, to, periodInvalid, refresh]);

  const loadMore = useCallback(() => {
    const current = stateRef.current;
    if (!current.response || current.loadingMore) return;
    const controller = new AbortController();
    moreController.current = controller;
    setState((s) => ({ ...s, loadingMore: true, error: "" }));
    search({ ...searchRequest(current.response.query, mode, kindKey, projectId, from, to), offset: current.hits.length }, controller.signal)
      .then((response) => setState((s) => ({ ...s, response, hits: mergeHits(s.hits, response.hits), loadingMore: false })))
      .catch((err) => {
        if (!controller.signal.aborted) setState((s) => ({ ...s, loadingMore: false, error: errorMessage(err) }));
      });
  }, [mode, kindKey, projectId, from, to]);

  const canLoadMore =
    state.response !== null && state.hits.length < state.response.total && state.hits.length <= SEARCH_MAX_OFFSET;
  return { ...state, loadMore, canLoadMore };
}

function ModeNotice({ response, requested }: { response: SearchResponseValue; requested: SearchModeValue }) {
  const degraded = requested !== "text" && (!response.semantic.available || response.modeUsed !== requested);
  if (!degraded) return null;
  return (
    <div className="banner warn" role="note">
      A busca semântica não está disponível agora ({semanticReasonText(response.semantic.reason)}).
      {response.modeUsed === "text" ? " Mostrando só os resultados por texto." : ""}
    </div>
  );
}

function ResultsArea({
  q,
  filters,
  results,
}: {
  q: string;
  filters: SearchFilterValues;
  results: ReturnType<typeof useSearchResults>;
}) {
  const { response, hits, loading, loadingMore, error, loadMore, canLoadMore } = results;
  if (!q) {
    return (
      <EmptyState icon={SearchIcon} title="Busque nas suas reuniões">
        Procure por palavras da conversa, decisões, pendências, riscos e ADRs. Use os filtros para limitar por projeto, período
        e tipo de conteúdo.
      </EmptyState>
    );
  }
  if (invalidPeriod(filters)) return null;
  if (loading) {
    return (
      <div role="status">
        <span className="sr-only">Buscando…</span>
        <SkeletonLines lines={5} />
      </div>
    );
  }
  if (error && !response) {
    return (
      <div className="banner error" role="alert">
        {error}
      </div>
    );
  }
  if (!response) return null;
  const meetings = new Set(hits.map((h) => h.meeting.id)).size;
  return (
    <>
      <ModeNotice response={response} requested={filters.mode} />
      {hits.length === 0 ? (
        <EmptyState icon={SearchX} title="Nada encontrado">
          Tente outras palavras, tire algum filtro ou troque o modo de busca.
        </EmptyState>
      ) : (
        <>
          <p className="small muted" role="status">
            {response.total} {response.total === 1 ? "resultado" : "resultados"}
            {hits.length < response.total ? ` (mostrando ${hits.length})` : ""} em {meetings}{" "}
            {meetings === 1 ? "reunião" : "reuniões"} · {Math.round(response.tookMs)} ms
          </p>
          <SearchResultList hits={hits} />
          {error && (
            <div className="banner error" role="alert">
              {error}
            </div>
          )}
          {canLoadMore && (
            <div className="search-more">
              <button type="button" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? "Carregando…" : "Mostrar mais resultados"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

export function Busca() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const { projects } = useProjects();
  const index = useIndexStatus();
  const inputRef = useRef<HTMLInputElement>(null);
  const q = params.get("q") ?? "";
  const filters = useMemo(() => parseFilters(params), [params]);
  const chatOff = index.status ? !index.status.chat.available : false;
  const tab: Tab = params.get("tab") === TAB_ASK && !chatOff ? TAB_ASK : TAB_SEARCH;
  const [draft, setDraft] = useState(q);
  const [refresh, setRefresh] = useState(0);
  const results = useSearchResults(q, filters, refresh);
  const focusToken = (location.state as { focusSearch?: number } | null)?.focusSearch;

  useEffect(() => setDraft(q), [q]);
  useEffect(() => {
    if (!focusToken) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  const go = (nextQ: string, nextFilters: SearchFilterValues, nextTab: Tab, replace = false) =>
    setParams(buildParams(nextQ, nextFilters, nextTab), { replace });

  function submit() {
    const text = draft.trim();
    if (text === q) setRefresh((n) => n + 1);
    else go(text, filters, tab);
  }

  if (index.disabled) {
    return (
      <main className="container">
        <PageHeader title="Busca" />
        <div className="banner warn" role="note">
          A busca nas reuniões está desligada neste servidor.
        </div>
      </main>
    );
  }

  return (
    <main className="container">
      <PageHeader title="Busca" description="Encontre trechos e faça perguntas sobre as reuniões que você pode ler." />
      <div className="tabs" role="tablist" aria-label="Modo da tela">
        {TABS.map((t) => {
          const unavailable = t.key === TAB_ASK && chatOff;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`busca-aba-${t.key}`}
              aria-selected={tab === t.key}
              aria-controls="busca-painel"
              disabled={unavailable}
              title={unavailable ? `Indisponível: ${chatUnavailableText(index.status?.chat.reason)}` : undefined}
              onClick={() => go(q, filters, t.key, true)}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {chatOff && (
        <p className="small muted" role="note">
          Perguntar está indisponível: {chatUnavailableText(index.status?.chat.reason)}.
        </p>
      )}
      <div id="busca-painel" role="tabpanel" aria-labelledby={`busca-aba-${tab}`}>
        {tab === TAB_ASK ? (
          <ChatPanel
            projects={projects}
            initialScope={{ projectId: filters.projectId, from: filters.from, to: filters.to }}
            livePaused={index.status?.paused === "reuniao_ao_vivo"}
          />
        ) : (
          <>
            <section className="card search-card">
              <SearchBox value={draft} onChange={setDraft} onSubmit={submit} busy={results.loading} inputRef={inputRef} />
              <SearchFilters
                values={filters}
                projects={projects}
                onChange={(patch) => go(q, { ...filters, ...patch }, tab, true)}
              />
              {hasActiveFilters(filters) && (
                <button type="button" className="link small" onClick={() => go(q, EMPTY_FILTERS, tab, true)}>
                  Limpar filtros
                </button>
              )}
            </section>
            <div aria-live="polite" aria-busy={results.loading}>
              <ResultsArea q={q} filters={filters} results={results} />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
