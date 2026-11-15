import type { AdminUsageReportValue } from "@meeting-bot/contracts";
import { asrSplit, byDay, byModel, byProvider, byPurpose, grouped, totals, type UsageScope } from "./aggregate";
import type { UsagePeriod } from "./period";
import { retentionInfo } from "./queries";

// Painel de admin: agregados da instância SEM nenhum dado de reunião (título, id, participantes,
// contagem por reunião). Nenhuma função daqui devolve `meeting_id`, e o tipo de retorno
// (AdminUsageReportValue) não tem campo de reunião. Admin não lê conteúdo alheio.

export function instanceScope(period: UsagePeriod): UsageScope {
  return { where: "l.at >= $1 AND l.at < $2", params: [period.from, period.to] };
}

/** Sem usuário e sem reunião de origem = instância; reunião sem dono = usuário removido. */
const USER_KEY = `CASE WHEN l.user_id IS NOT NULL THEN l.user_id::text
                       WHEN l.meeting_id IS NOT NULL THEN 'removed'
                       ELSE 'instance' END`;

function userLabel(key: string, row: Record<string, unknown>): string {
  if (key === "instance") return "Instância";
  if (key === "removed") return "Usuário removido";
  return String(row.username ?? key);
}

export async function adminUsageReport(period: UsagePeriod): Promise<AdminUsageReportValue> {
  const scope = instanceScope(period);
  const [all, users, purposes, providers, models, days, asr] = await Promise.all([
    totals(scope),
    grouped(scope, {
      key: USER_KEY,
      join: "LEFT JOIN users u ON u.id = l.user_id",
      extra: "u.username AS username",
      order: "count(*) DESC, 1",
      label: userLabel,
    }),
    byPurpose(scope),
    byProvider(scope),
    byModel(scope),
    byDay(scope),
    asrSplit(scope),
  ]);
  return {
    period: { from: period.from.toISOString(), to: period.to.toISOString(), month: period.month },
    totals: all,
    byUser: users,
    byPurpose: purposes,
    byProvider: providers,
    byModel: models,
    byDay: days,
    asr,
    retention: retentionInfo(),
  };
}
