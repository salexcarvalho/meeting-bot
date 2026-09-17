// Tela de pré-entrada do Meet/Teams dirigida por um laço único de sondagem: reage ao que
// aparecer, em qualquer ordem, em vez de somar timeouts fixos de cada botão opcional.

export interface JoinControl {
  name: string;
  visible(): Promise<boolean>;
  act(): Promise<void>;
}

export interface JoinScreen {
  /** Avisos e telas intermediárias ("continuar no navegador", "entendi"...). */
  dismiss: JoinControl[];
  nameInput: {
    visible(): Promise<boolean>;
    value(): Promise<string>;
    fill(name: string): Promise<void>;
  };
  /** Desligar câmera/microfone: cada um só é visível enquanto está ligado. */
  toggles: JoinControl[];
  join: {
    visible(): Promise<boolean>;
    enabled(): Promise<boolean>;
    click(): Promise<void>;
  };
  /** Mensagem de erro definitiva (link inválido, entrada bloqueada) ou null. */
  failure(): Promise<string | null>;
}

export interface JoinOptions {
  timeoutMs: number;
  pollMs?: number;
  /** Espera extra, depois que o "Entrar" aparece, pelo campo de nome e pelas chaves de mídia. */
  graceMs?: number;
  failureCheckMs?: number;
  signal?: AbortSignal;
  onJoining?: () => void;
  log?: (msg: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class JoinError extends Error {
  constructor(
    message: string,
    readonly kind: "timeout" | "failure" | "aborted",
  ) {
    super(message);
    this.name = "JoinError";
  }
}

const MAX_DISMISS = 2;

const safe = async (fn: () => Promise<boolean>): Promise<boolean> => {
  try {
    return await fn();
  } catch {
    return false;
  }
};

export async function driveJoin(screen: JoinScreen, displayName: string, opts: JoinOptions): Promise<void> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 250;
  const graceMs = opts.graceMs ?? 1500;
  const failureCheckMs = opts.failureCheckMs ?? 1000;
  const log = opts.log ?? (() => {});

  const start = now();
  const dismissed = new Map<string, number>();
  const toggled = new Set<string>();
  let joining = false;
  let nameFilled = false;
  let joinSeenAt: number | null = null;
  let lastFailureCheck = -Infinity;

  const markJoining = () => {
    if (joining) return;
    joining = true;
    opts.onJoining?.();
  };

  for (;;) {
    if (opts.signal?.aborted) throw new JoinError("Cancelado antes de entrar na reunião.", "aborted");
    const t = now();
    if (t - start > opts.timeoutMs) {
      const where = joinSeenAt === null ? "o botão de entrar não apareceu" : "o botão de entrar não ficou disponível";
      throw new JoinError(`Tempo esgotado ao entrar na reunião (${where}).`, "timeout");
    }

    if (t - lastFailureCheck >= failureCheckMs) {
      lastFailureCheck = t;
      const failure = await screen.failure().catch(() => null);
      if (failure) throw new JoinError(failure, "failure");
    }

    for (const control of screen.dismiss) {
      const count = dismissed.get(control.name) ?? 0;
      if (count >= MAX_DISMISS || !(await safe(control.visible))) continue;
      dismissed.set(control.name, count + 1);
      await control.act().then(
        () => log(`tela "${control.name}" fechada (${now() - start} ms)`),
        () => {},
      );
    }

    if (await safe(screen.nameInput.visible)) {
      markJoining();
      const current = await screen.nameInput.value().catch(() => "");
      if (current !== displayName) {
        await screen.nameInput.fill(displayName).catch(() => {});
        log(`nome preenchido (${now() - start} ms)`);
      }
      nameFilled = (await screen.nameInput.value().catch(() => "")) === displayName;
    }

    for (const control of screen.toggles) {
      if (toggled.has(control.name) || !(await safe(control.visible))) continue;
      markJoining();
      await control.act().then(
        () => {
          toggled.add(control.name);
          log(`${control.name} desligado (${now() - start} ms)`);
        },
        () => {},
      );
    }

    if (await safe(screen.join.visible)) {
      markJoining();
      joinSeenAt ??= now();
      const waited = now() - joinSeenAt;
      const togglesPending = toggled.size < screen.toggles.length;
      const ready =
        (nameFilled || waited >= graceMs) && (!togglesPending || waited >= graceMs) && (await safe(screen.join.enabled));
      if (ready && (await screen.join.click().then(() => true, () => false))) {
        log(`pedido de entrada enviado (${now() - start} ms)`);
        return;
      }
    }

    await sleep(pollMs);
  }
}
