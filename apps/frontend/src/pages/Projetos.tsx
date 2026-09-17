import { useState, type FormEvent } from "react";
import { Link } from "react-router";
import { FolderKanban, Pencil, Plus, Trash2 } from "lucide-react";
import type { Project } from "@meeting-bot/contracts";
import { api, errorMessage } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { useToast } from "../components/Toast";
import { CardHead, EmptyState, PageHeader } from "../components/ui";
import { useProjects } from "../hooks";

const parseKeywords = (value: string) =>
  value
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length >= 2);

export function Projetos() {
  const toast = useToast();
  const { projects, reload } = useProjects();
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Project | null>(null);
  const [error, setError] = useState("");

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    setError("");
    try {
      await api("/projects", {
        method: "POST",
        json: { name: String(data.get("name") ?? "").trim(), keywords: parseKeywords(String(data.get("keywords") ?? "")) },
      });
      form.reset();
      toast("Projeto criado.");
      reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function save(p: Project, e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    try {
      await api(`/projects/${p.id}`, {
        method: "PATCH",
        json: { name: String(data.get("name") ?? "").trim(), keywords: parseKeywords(String(data.get("keywords") ?? "")) },
      });
      setEditing(null);
      toast("Projeto atualizado.");
      reload();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  async function remove(p: Project) {
    try {
      await api(`/projects/${p.id}`, { method: "DELETE" });
      toast("Projeto excluído.");
      reload();
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  }

  return (
    <main className="container">
      <PageHeader
        title="Projetos"
        description="As palavras-chave sugerem o projeto pelo título da reunião na importação. A sugestão fica marcada até você confirmar na edição da reunião."
      />
      <section className="card flush">
        <CardHead title="Projetos cadastrados" icon={FolderKanban} />
        {projects.length === 0 ? (
          <div style={{ padding: "0 20px 20px" }}>
            <EmptyState icon={FolderKanban} title="Nenhum projeto">
              Crie um projeto abaixo para agrupar reuniões.
            </EmptyState>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="simple">
              <thead>
                <tr>
                  <th>Projeto</th>
                  <th className="hide-sm">Palavras-chave</th>
                  <th className="num">Reuniões</th>
                  <th><span className="sr-only">Ações</span></th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) =>
                  editing === p.id ? (
                    <tr key={p.id}>
                      <td colSpan={4}>
                        <form className="row" onSubmit={(e) => save(p, e)}>
                          <input name="name" defaultValue={p.name} required minLength={2} maxLength={80} aria-label="Nome" autoFocus />
                          <input name="keywords" defaultValue={p.keywords.join(", ")} aria-label="Palavras-chave" style={{ flex: 1, minWidth: 160 }} />
                          <button className="primary small">Salvar</button>
                          <button type="button" className="small" onClick={() => setEditing(null)}>Cancelar</button>
                        </form>
                      </td>
                    </tr>
                  ) : (
                    <tr key={p.id}>
                      <td>
                        <Link className="cell-title" to={`/reunioes?projeto=${p.id}`}>{p.name}</Link>
                        <div className="cell-sub only-sm">{p.keywords.join(", ")}</div>
                      </td>
                      <td className="hide-sm muted">{p.keywords.join(", ") || "—"}</td>
                      <td className="num">{p.meetingCount}</td>
                      <td className="actions">
                        <button type="button" className="ghost icon small" aria-label={`Editar ${p.name}`} title="Editar" onClick={() => setEditing(p.id)}>
                          <Pencil />
                        </button>
                        <button type="button" className="ghost icon small danger" aria-label={`Excluir ${p.name}`} title="Excluir" onClick={() => setRemoving(p)}>
                          <Trash2 />
                        </button>
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <form className="card" onSubmit={create}>
        <CardHead title="Novo projeto" icon={Plus} />
        <div className="grid-2" style={{ gap: 16 }}>
          <label>
            Nome
            <input name="name" required minLength={2} maxLength={80} />
          </label>
          <label>
            Palavras-chave (separadas por vírgula)
            <input name="keywords" placeholder="ex.: farmácia, medicamentos" />
          </label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary">Criar projeto</button>
      </form>

      <ConfirmDialog
        open={Boolean(removing)}
        title="Excluir projeto?"
        message={removing ? `As ${removing.meetingCount} reunião(ões) de “${removing.name}” ficam sem projeto.` : ""}
        confirmLabel="Excluir"
        danger
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && void remove(removing)}
      />
    </main>
  );
}
