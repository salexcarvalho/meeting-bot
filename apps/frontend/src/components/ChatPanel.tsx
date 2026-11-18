import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Send, Trash2 } from "lucide-react";
import {
  CHAT_HISTORY_MAX,
  CHAT_MESSAGE_MAX,
  CHAT_QUESTION_MAX,
  type ChatCitationValue,
  type ChatRequestInput,
  type ChatResponseValue,
  type Project,
} from "@meeting-bot/contracts";
import { errorMessage, searchChat } from "../api";
import { CitationChip } from "./CitationChip";
import { SearchHitRow } from "./SearchResult";

// Conversa sobre as reuniões. O histórico vive só nesta tela (memória): fechar ou recarregar apaga tudo.

export interface ChatScopeFields {
  projectId: string;
  from: string;
  to: string;
}

interface ChatTurn {
  id: number;
  question: string;
  pending: boolean;
  response?: ChatResponseValue;
  error?: string;
}

type HistoryMessage = NonNullable<ChatRequestInput["history"]>[number];

/** Só turnos respondidos entram no histórico: no máximo 6 mensagens de até 1000 caracteres. */
function buildHistory(turns: ChatTurn[]): HistoryMessage[] {
  const messages: HistoryMessage[] = turns.flatMap((turn) =>
    turn.response?.answered
      ? [
          { role: "user" as const, content: turn.question.slice(0, CHAT_MESSAGE_MAX) },
          { role: "assistant" as const, content: turn.response.answer.slice(0, CHAT_MESSAGE_MAX) },
        ]
      : [],
  );
  return messages.slice(-CHAT_HISTORY_MAX);
}

function buildScope(scope: ChatScopeFields): ChatRequestInput["scope"] {
  if (!scope.projectId && !scope.from && !scope.to) return undefined;
  return {
    ...(scope.projectId ? { projectId: scope.projectId } : {}),
    ...(scope.from ? { from: scope.from } : {}),
    ...(scope.to ? { to: scope.to } : {}),
  };
}

function useChat() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;
  const nextId = useRef(0);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const patch = useCallback((id: number, change: Partial<ChatTurn>) => {
    setTurns((list) => list.map((t) => (t.id === id ? { ...t, ...change } : t)));
  }, []);

  const ask = useCallback(
    async (question: string, scope: ChatScopeFields) => {
      const id = nextId.current++;
      const history = buildHistory(turnsRef.current);
      const requestScope = buildScope(scope);
      const ctl = new AbortController();
      controller.current = ctl;
      setTurns((list) => [...list, { id, question, pending: true }]);
      try {
        const response = await searchChat(
          {
            question,
            ...(history.length ? { history } : {}),
            ...(requestScope ? { scope: requestScope } : {}),
          },
          ctl.signal,
        );
        patch(id, { pending: false, response });
      } catch (err) {
        if (!ctl.signal.aborted) patch(id, { pending: false, error: errorMessage(err) });
      }
    },
    [patch],
  );

  const clear = useCallback(() => setTurns([]), []);
  return { turns, ask, clear, busy: turns.some((t) => t.pending) };
}

/** Texto da resposta com os marcadores [n] viram links para a fonte; marcador sem fonte fica como texto. */
function renderAnswer(answer: string, citations: ChatCitationValue[]): ReactNode[] {
  const byRef = new Map(citations.map((c) => [c.ref, c]));
  let offset = 0;
  return answer.split(/\[(\d{1,3})\]/).map((part, position) => {
    const key = offset;
    offset += part.length + 1;
    if (position % 2 === 0) return <span key={key}>{part}</span>;
    const citation = byRef.get(Number(part));
    return citation ? <CitationChip key={key} citation={citation} /> : <span key={key}>[{part}]</span>;
  });
}

function CitationList({ citations }: { citations: ChatCitationValue[] }) {
  if (!citations.length) return null;
  return (
    <section aria-label="Fontes citadas">
      <h3 className="small muted">Fontes</h3>
      <ol className="chat-sources">
        {citations.map((c) => (
          <li key={c.ref}>
            <CitationChip citation={c} variant="full" />
            {c.proposed && <span className="badge warn">proposto pela IA</span>}
            {c.quote && (
              <blockquote className="chat-quote">
                {c.quote}
                {!c.exact && <span className="muted small"> (trecho aproximado)</span>}
              </blockquote>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ChatAnswer({ response }: { response: ChatResponseValue }) {
  return (
    <div className="chat-a">
      {response.liveBusy && (
        <div className="banner warn small" role="note">
          Há uma reunião ao vivo: a resposta pode demorar e usar menos contexto.
        </div>
      )}
      {response.answered ? (
        <>
          <p className="chat-answer">{renderAnswer(response.answer, response.citations)}</p>
          <CitationList citations={response.citations} />
        </>
      ) : (
        <div className="banner" role="note">
          <strong>{response.answer}</strong>
          <span className="small muted"> Tente outras palavras ou amplie o projeto e o período.</span>
        </div>
      )}
      {response.sources.length > 0 && (
        <details className="chat-consulted">
          <summary className="small">Trechos consultados ({response.sources.length})</summary>
          <ul className="search-hits">
            {response.sources.map((hit) => (
              <SearchHitRow key={hit.id} hit={hit} showMeeting />
            ))}
          </ul>
        </details>
      )}
      <p className="small muted">Modelo: {response.model}</p>
    </div>
  );
}

function ChatTurnView({ turn }: { turn: ChatTurn }) {
  return (
    <div className="chat-turn">
      <p className="chat-q">{turn.question}</p>
      {turn.pending && (
        <p className="chat-wait" role="status">
          <span className="spinner" aria-hidden="true" /> Gerando a resposta… pode levar até 30 segundos.
        </p>
      )}
      {turn.error && (
        <div className="banner error" role="alert">
          {turn.error}
        </div>
      )}
      {turn.response && <ChatAnswer response={turn.response} />}
    </div>
  );
}

function ScopeFields({
  scope,
  projects,
  onChange,
}: {
  scope: ChatScopeFields;
  projects: Project[];
  onChange: (patch: Partial<ChatScopeFields>) => void;
}) {
  return (
    <details className="chat-scope" open={Boolean(scope.projectId || scope.from || scope.to)}>
      <summary className="small">Limitar a pergunta (opcional)</summary>
      <div className="search-filters-grid">
        <label>
          Projeto
          <select value={scope.projectId} onChange={(e) => onChange({ projectId: e.target.value })}>
            <option value="">Todos os projetos</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </label>
        <label>
          De
          <input type="date" value={scope.from} max={scope.to || undefined} onChange={(e) => onChange({ from: e.target.value })} />
        </label>
        <label>
          Até
          <input type="date" value={scope.to} min={scope.from || undefined} onChange={(e) => onChange({ to: e.target.value })} />
        </label>
      </div>
    </details>
  );
}

export function ChatPanel({
  projects,
  initialScope,
  livePaused,
}: {
  projects: Project[];
  initialScope: ChatScopeFields;
  /** o servidor está priorizando uma reunião ao vivo */
  livePaused: boolean;
}) {
  const { turns, ask, clear, busy } = useChat();
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<ChatScopeFields>(initialScope);
  const periodInvalid = Boolean(scope.from && scope.to && scope.from > scope.to);
  const canSend = !busy && !periodInvalid && question.trim().length > 0;

  function submit(e?: FormEvent) {
    e?.preventDefault();
    if (!canSend) return;
    void ask(question.trim(), scope);
    setQuestion("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  }

  return (
    <section className="card chat-panel" aria-label="Perguntar sobre as reuniões">
      <p className="card-desc">
        Pergunte em linguagem natural. A resposta usa só trechos das reuniões que você pode ler, é gerada pelo LLM externo configurado (os trechos e a
        pergunta saem da máquina) e traz as fontes. Itens e ADRs ainda não aprovados aparecem como propostos pela IA.
      </p>
      {livePaused && (
        <div className="banner warn small" role="note">
          Há uma reunião ao vivo: a indexação de novas reuniões fica em pausa.
        </div>
      )}
      <div className="chat-log" role="log" aria-live="polite" aria-label="Conversa">
        {turns.length === 0 && <p className="muted">Nenhuma pergunta ainda. A conversa fica só nesta tela e não é guardada.</p>}
        {turns.map((turn) => (
          <ChatTurnView key={turn.id} turn={turn} />
        ))}
      </div>
      <form className="chat-form" onSubmit={submit}>
        <ScopeFields scope={scope} projects={projects} onChange={(p) => setScope((s) => ({ ...s, ...p }))} />
        <label htmlFor="chat-pergunta">Sua pergunta</label>
        <textarea
          id="chat-pergunta"
          value={question}
          maxLength={CHAT_QUESTION_MAX}
          rows={3}
          placeholder="Ex.: o que ficou decidido sobre o prazo da migração?"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="row between">
          <span className="small muted">
            {question.length}/{CHAT_QUESTION_MAX} · Enter envia, Shift+Enter quebra a linha
          </span>
          <div className="row">
            {turns.length > 0 && (
              <button type="button" className="small" disabled={busy} onClick={clear}>
                <Trash2 aria-hidden="true" /> Limpar conversa
              </button>
            )}
            <button type="submit" className="primary" disabled={!canSend}>
              <Send aria-hidden="true" /> {busy ? "Respondendo…" : "Perguntar"}
            </button>
          </div>
        </div>
        {periodInvalid && <p className="error-text small" role="alert">A data inicial é depois da final.</p>}
      </form>
    </section>
  );
}
