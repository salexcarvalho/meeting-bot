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
  /** Desligar o microfone: só é visível enquanto ele está ligado. */
  mute: JoinControl[];
  /** Chave da câmera na pré-entrada (null enquanto não aparece). */
  camera: {
    state(): Promise<CameraState | null>;
    set(on: boolean): Promise<void>;
  };
  join: {
    visible(): Promise<boolean>;
    enabled(): Promise<boolean>;
    click(): Promise<void>;
  };
  /** Mensagem de erro definitiva (link inválido, entrada bloqueada) ou null. */
  failure(): Promise<string | null>;
}

export type CameraState = "on" | "off";

/** Como o assistente se apresenta: o nome (sempre com o aviso de gravação) e se liga a câmera. */
export interface JoinIdentity {
  name: string;
  /** há ícone para mostrar: liga a câmera virtual; senão, desliga */
  camera: boolean;
}

export interface JoinResult {
  /** a câmera (com o ícone) ficou ligada */
  camera: boolean;
  /** a tela pediu um nome: entrou como convidado (com conta conectada, a sessão venceu) */
  guestForm: boolean;
}

export interface JoinOptions {
  timeoutMs: number;
  pollMs?: number;
  /** Espera extra, depois que o "Entrar" aparece, pelo campo de nome e pelas chaves de mídia. */
  graceMs?: number;
  /** Quanto esperar, depois do "Entrar", pela câmera ligada antes de entrar sem ela. */
  cameraGraceMs?: number;
  /** Intervalo entre tentativas de ligar/desligar a câmera. */
  cameraRetryMs?: number;
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
const MAX_CAMERA_TRIES = 3;

const safe = async (fn: () => Promise<boolean>): Promise<boolean> => {
  try {
    return await fn();
  } catch {
    return false;
  }
};

export async function driveJoin(screen: JoinScreen, identity: JoinIdentity, opts: JoinOptions): Promise<JoinResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 250;
  const graceMs = opts.graceMs ?? 1500;
  const cameraGraceMs = opts.cameraGraceMs ?? 5000;
  const cameraRetryMs = opts.cameraRetryMs ?? 2000;
  const failureCheckMs = opts.failureCheckMs ?? 1000;
  const log = opts.log ?? (() => {});

  const start = now();
  const dismissed = new Map<string, number>();
  const muted = new Set<string>();
  let joining = false;
  let joinSeenAt: number | null = null;
  let lastFailureCheck = -Infinity;
  let cameraSeen = false;
  let cameraTries = 0;
  let cameraSetAt = -Infinity;
  let nameFilled = false;
  let guestForm = false;

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

    const camera = await screen.camera.state().catch(() => null);
    if (camera) {
      markJoining();
      cameraSeen = true;
      const mismatch = (camera === "on") !== identity.camera;
      if (mismatch && cameraTries < MAX_CAMERA_TRIES && now() - cameraSetAt >= cameraRetryMs) {
        cameraTries++;
        cameraSetAt = now();
        await screen.camera.set(identity.camera).then(
          () => log(`câmera: pedido para ${identity.camera ? "ligar" : "desligar"} (${now() - start} ms)`),
          () => {},
        );
      }
    }

    if (await safe(screen.nameInput.visible)) {
      guestForm = true;
      markJoining();
      if ((await screen.nameInput.value().catch(() => "")) !== identity.name) {
        await screen.nameInput.fill(identity.name).catch(() => {});
        // O Teams às vezes devolve o campo vazio na leitura seguinte: preenche de novo, sem repetir o log.
        if (!nameFilled) log(`nome preenchido (${now() - start} ms)`);
      }
      nameFilled = (await screen.nameInput.value().catch(() => "")) === identity.name;
    }

    for (const control of screen.mute) {
      if (muted.has(control.name) || !(await safe(control.visible))) continue;
      markJoining();
      await control.act().then(
        () => {
          muted.add(control.name);
          log(`${control.name} desligado (${now() - start} ms)`);
        },
        () => {},
      );
    }

    if (await safe(screen.join.visible)) {
      markJoining();
      joinSeenAt ??= now();
      const waited = now() - joinSeenAt;
      const nameOk = nameFilled || waited >= graceMs;
      const muteOk = muted.size >= screen.mute.length || waited >= graceMs;
      const cameraOk = identity.camera
        ? camera === "on" ||
          waited >= cameraGraceMs ||
          (!cameraSeen && waited >= graceMs) ||
          (cameraTries >= MAX_CAMERA_TRIES && now() - cameraSetAt >= cameraRetryMs)
        : camera !== "on" || waited >= graceMs;
      const ready = nameOk && muteOk && cameraOk && (await safe(screen.join.enabled));
      if (ready && (await screen.join.click().then(() => true, () => false))) {
        const cameraOn = identity.camera && camera === "on";
        log(`pedido de entrada enviado, câmera ${cameraOn ? "com o ícone" : "desligada"} (${now() - start} ms)`);
        return { camera: cameraOn, guestForm };
      }
    }

    await sleep(pollMs);
  }
}
