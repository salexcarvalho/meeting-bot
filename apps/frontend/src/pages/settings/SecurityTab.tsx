import { ShieldCheck } from "lucide-react";
import { AuditList } from "../../components/AuditList";
import { CardHead } from "../../components/ui";

// Os eventos de segurança que dizem respeito a mim: entradas, trocas de senha, ações de administrador
// sobre a minha conta e tudo que saiu da máquina em meu nome. Só leitura.

export function SecurityTab() {
  return (
    <section className="card">
      <CardHead title="Segurança" icon={ShieldCheck} />
      <p className="card-desc">
        Entradas e tentativas de entrada na sua conta, troca de senha, conta Teams, ações de um administrador sobre a sua conta e os
        envios para fora da máquina feitos em seu nome (qual provedor e quando; o conteúdo nunca aparece aqui). Se algo não foi você, troque a
        senha e avise um administrador.
      </p>
      <AuditList endpoint="/audit/me" showPeople={false} emptyHint="Quando houver entrada na conta, troca de senha ou envio externo, ele aparece aqui." />
    </section>
  );
}
