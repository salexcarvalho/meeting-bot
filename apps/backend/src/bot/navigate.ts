// Abrir o link da reunião falha por queda de rede passageira (às 11:00 de 2026-09-18 dois bots
// tomaram ERR_TIMED_OUT no mesmo segundo, e a rede voltou logo depois). Erro de rede se repete;
// erro de página (link inválido, bloqueio) não.

const TRANSIENT =
  /net::ERR_(TIMED_OUT|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|NETWORK_CHANGED|ADDRESS_UNREACHABLE|CONNECTION_[A-Z_]+|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED)/;

/** O erro é uma falha de rede que costuma passar sozinha? */
export function isTransientNetworkError(message: string | null | undefined): boolean {
  return TRANSIENT.test(message ?? "");
}

export interface Navigable {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<unknown>;
}

export interface NavigateOptions {
  /** total de tentativas (a primeira inclusa) */
  attempts?: number;
  timeoutMs?: number;
  /** espera antes de cada nova tentativa */
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  signal?: AbortSignal;
}

/** `page.goto` que repete só quando o erro é de rede; o último erro sobe intacto. */
export async function gotoWithRetry(page: Navigable, url: string, opts: NavigateOptions = {}): Promise<void> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const backoff = opts.backoffMs ?? [5_000, 15_000];
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      return;
    } catch (err) {
      const last = attempt >= attempts;
      if (last || opts.signal?.aborted || !isTransientNetworkError((err as Error).message)) throw err;
      const wait = backoff[Math.min(attempt - 1, backoff.length - 1)] ?? 5_000;
      opts.log?.(`rede falhou ao abrir a reunião (tentativa ${attempt}/${attempts}); repetindo em ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }
}
