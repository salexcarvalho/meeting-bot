import { useEffect, useState } from "react";
import { ScrollText } from "lucide-react";
import type { AdminUser } from "@meeting-bot/contracts";
import { api } from "../../api";
import { AuditList } from "../../components/AuditList";
import { CardHead, PageHeader } from "../../components/ui";
import { useCan } from "../../session";

// Auditoria do sistema: ações administrativas, bloqueios de saída, falhas de autenticação do agente,
// envios externos e poda de registros. Sempre projetada: nunca mostra conteúdo nem título de reunião.

export function Auditoria() {
  const can = useCan();
  const [users, setUsers] = useState<{ id: string; username: string }[]>([]);

  useEffect(() => {
    if (!can("users.read")) return;
    api<{ users: AdminUser[] }>("/admin/users")
      .then((r) => setUsers(r.users.map((u) => ({ id: u.id, username: u.username }))))
      .catch(() => setUsers([]));
  }, [can]);

  return (
    <main className="container">
      <PageHeader title="Auditoria" description="Eventos do sistema, sem conteúdo de reunião." />
      <section className="card">
        <CardHead title="Eventos" icon={ScrollText} />
        <p className="card-desc">
          Cada linha mostra o tipo, a data e só os campos permitidos para aquele tipo. Tipos novos sem regra de exibição aparecem apenas com o nome do tipo.
        </p>
        <AuditList endpoint="/admin/audit" showPeople users={users} emptyHint="Nenhum evento do sistema neste período." />
      </section>
    </main>
  );
}
