import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import type { AdminUsageReportValue } from "@meeting-bot/contracts";
import { CardHead, EmptyState, PageHeader, SkeletonLines } from "../../components/ui";
import { defaultPeriod, PeriodPicker, type Period } from "../../components/usage/PeriodPicker";
import { DailyBars, GroupTable, RetentionNote, UsageKpis } from "../../components/usage/UsageParts";
import { useReport } from "../../components/usage/useReport";

// Uso de IA da instância: agregados por usuário, provedor, modelo, finalidade e dia. Nunca mostra título,
// id ou contagem de reunião de ninguém (o tipo do relatório nem tem esses campos).

export function UsoIA() {
  const [period, setPeriod] = useState<Period>(defaultPeriod);
  const { report, error, busy } = useReport<AdminUsageReportValue>("/admin/usage", period);

  return (
    <main className="container">
      <PageHeader title="Uso de IA" description="Consumo da instância, somado por usuário, provedor e finalidade." />
      <section className="card">
        <CardHead title="Visão geral" icon={ShieldCheck} actions={<PeriodPicker value={period} onChange={setPeriod} />} />
        <div className="banner info" role="note">
          <ShieldCheck size={16} aria-hidden="true" />
          <span>Agregados da instância; conteúdo e títulos de reuniões não aparecem aqui. O custo é o informado pelo provedor.</span>
        </div>
        {error && <div className="banner error">{error}</div>}
        {busy && !report && <SkeletonLines lines={4} />}
        {report && (
          <div aria-busy={busy}>
            <UsageKpis totals={report.totals} asr={report.asr} />
            {report.totals.calls === 0 ? (
              <EmptyState title="Nenhum consumo neste período">Quando alguém gerar uma ata ou transcrever uma reunião, o total aparece aqui.</EmptyState>
            ) : (
              <>
                <GroupTable title="Usuário" rows={report.byUser} />
                <DailyBars days={report.byDay} />
                <GroupTable title="Provedor" rows={report.byProvider} />
                <GroupTable title="Modelo" rows={report.byModel} />
                <GroupTable title="Finalidade" rows={report.byPurpose} />
              </>
            )}
            <RetentionNote days={report.retention.usageDays} what="Os registros de consumo" />
          </div>
        )}
      </section>
    </main>
  );
}
