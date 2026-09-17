// LOCAL_ONLY (Constituição, princípio I): o backend só fala com serviços locais.
// Qualquer fetch para outro host é recusado antes de sair e vira registro de auditoria.
// Exceção opt-in: endpoints externos liberados por host + prefixo de caminho (ASR de teste).

export class EgressBlockedError extends Error {
  constructor(readonly host: string) {
    super(`Acesso a ${host} bloqueado (LOCAL_ONLY).`);
    this.name = "EgressBlockedError";
  }
}

export interface BlockedRequest {
  host: string;
  method: string;
  protocol: string;
}

export interface AllowedEndpoint {
  host: string;
  pathPrefix: string;
}

export function isAllowedHost(host: string, allowlist: string[]): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  return allowlist.includes(h);
}

export function isAllowedEndpoint(url: URL, endpoints: AllowedEndpoint[]): boolean {
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  // Caminho normalizado pelo URL (sem "..").
  return endpoints.some((e) => e.host.toLowerCase() === host && (url.pathname === e.pathPrefix || url.pathname.startsWith(`${e.pathPrefix}/`)));
}

function targetOf(input: Parameters<typeof fetch>[0]): URL {
  if (input instanceof URL) return input;
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

export function installEgressGuard(opts: {
  allowlist: string[];
  endpoints?: AllowedEndpoint[];
  onBlocked: (req: BlockedRequest) => void;
}): () => void {
  const original = globalThis.fetch;
  const allowlist = opts.allowlist.map((h) => h.toLowerCase());

  const guarded: typeof fetch = async (input, init) => {
    const url = targetOf(input);
    if (!isAllowedHost(url.hostname, allowlist) && !isAllowedEndpoint(url, opts.endpoints ?? [])) {
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      try {
        opts.onBlocked({ host: url.hostname, method, protocol: url.protocol });
      } catch {
        // auditoria nunca deve liberar a requisição
      }
      throw new EgressBlockedError(url.hostname);
    }
    return original(input, init);
  };

  globalThis.fetch = guarded;
  return () => {
    if (globalThis.fetch === guarded) globalThis.fetch = original;
  };
}
