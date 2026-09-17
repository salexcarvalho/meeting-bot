import { useMemo, useState } from "react";
import type { Channel, Item, ItemType, ReviewStatus } from "@meeting-bot/contracts";
import { ItemCard } from "./ItemCard";
import { NewItemForm } from "./NewItemForm";

const PANELS: { title: string; types: ItemType[] }[] = [
  { title: "Decisões", types: ["decisao"] },
  { title: "Decisões arquiteturais", types: ["decisao_arquitetural"] },
  { title: "Pendências", types: ["pendencia"] },
  { title: "Riscos", types: ["risco"] },
  { title: "Requisitos", types: ["requisito_funcional", "requisito_nao_funcional"] },
  { title: "Outros", types: ["regra_negocio", "restricao", "premissa", "pergunta_aberta", "debito_tecnico"] },
];

type Filter = "todos" | ReviewStatus;

export function ItemsBoard({
  meetingId,
  items,
  onChange,
  onEvidence,
  onGenerateAdr,
  readOnly = false,
}: {
  meetingId: string;
  readOnly?: boolean;
  items: Item[];
  onChange: (item: Item) => void;
  onEvidence?: (segmentId: number | null, channel: Channel, start: number) => void;
  onGenerateAdr?: (item: Item) => void;
}) {
  const [filter, setFilter] = useState<Filter>("todos");
  const [creating, setCreating] = useState(false);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { todos: 0, proposto: 0, aprovado: 0, rejeitado: 0 };
    for (const i of items) {
      c[i.reviewStatus]++;
      if (i.reviewStatus !== "rejeitado") c.todos++;
    }
    return c;
  }, [items]);
  const visible = items.filter((i) => (filter === "todos" ? i.reviewStatus !== "rejeitado" : i.reviewStatus === filter));

  return (
    <section>
      <div className="row between" style={{ marginBottom: 10 }}>
        <div className="tabs" role="tablist" style={{ marginBottom: 0, borderBottom: 0 }}>
          {(["todos", "proposto", "aprovado", "rejeitado"] as Filter[]).map((f) => (
            <button key={f} type="button" role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}>
              {f === "todos" ? "Ativos" : `${f[0].toUpperCase()}${f.slice(1)}s`} ({counts[f]})
            </button>
          ))}
        </div>
        {!readOnly && (
          <button type="button" className="small" onClick={() => setCreating(true)}>+ Novo item</button>
        )}
      </div>
      <div className="board">
        {PANELS.map((panel) => {
          const list = visible.filter((i) => panel.types.includes(i.type));
          return (
            <div key={panel.title} className="panel">
              <h3>
                {panel.title} <span className="muted small">{list.length}</span>
              </h3>
              {list.length === 0 ? (
                <div className="panel-empty">Nada ainda.</div>
              ) : (
                list.map((item) => (
                  <ItemCard
                    key={item.id}
                    item={item}
                    readOnly={readOnly}
                    onChange={onChange}
                    onEvidence={onEvidence}
                    onGenerateAdr={onGenerateAdr}
                  />
                ))
              )}
            </div>
          );
        })}
      </div>
      <NewItemForm meetingId={meetingId} open={creating} onClose={() => setCreating(false)} onCreated={onChange} />
    </section>
  );
}
