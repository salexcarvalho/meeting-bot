import { Locator, Page } from "playwright";
import { CameraState, driveJoin, JoinControl, JoinIdentity, JoinOptions, JoinResult, JoinScreen } from "./join";

/**
 * Seletores de cada plataforma num lugar só. Meet e Teams mudam a UI sem
 * aviso — quando o bot parar de entrar, olhe o screenshot de debug da
 * reunião na interface e ajuste aqui.
 */
export interface PlatformDriver {
  /** Abre o link e envia o pedido de entrada; `onJoining` marca a chegada na tela de pré-entrada. */
  join(
    page: Page,
    url: string,
    identity: JoinIdentity,
    opts: Omit<JoinOptions, "log">,
    log: (msg: string) => void,
  ): Promise<JoinResult>;
  isInCall(page: Page): Promise<boolean>;
  isDenied(page: Page): Promise<boolean>;
  isInvalidLink(page: Page): Promise<boolean>;
  /** Desliga o microfone (nunca religa). */
  ensureMuted(page: Page): Promise<void>;
  /** Câmera na chamada: null quando o botão não está na tela. */
  cameraState(page: Page): Promise<CameraState | null>;
  setCamera(page: Page, on: boolean): Promise<void>;
  isAlone(page: Page): Promise<boolean>;
  /** Pessoas na chamada (inclui o assistente); null quando não dá para ler. */
  participantCount(page: Page): Promise<number | null>;
  /** Tela de "a chamada terminou" / "você saiu". */
  hasEnded(page: Page): Promise<boolean>;
}

// O botão de pessoas leva o total no nome ("People 8", "Pessoas 8", "Show everyone 3").
async function countFrom(locator: Locator): Promise<number | null> {
  const button = locator.first();
  if (!(await button.isVisible().catch(() => false))) return null;
  const name = ((await button.getAttribute("aria-label").catch(() => null)) ?? (await button.innerText().catch(() => ""))).trim();
  const found = name.match(/\d+/);
  return found ? Number(found[0]) : null;
}

// Clica só se já estiver na tela (sem esperar o elemento aparecer).
async function clickIfShown(locator: Locator): Promise<void> {
  const first = locator.first();
  if (await first.isVisible().catch(() => false)) await first.click({ timeout: 2000 }).catch(() => {});
}

// isVisible() não espera (o timeout dele é ignorado pelo Playwright): serve para sondar.
async function anyVisible(page: Page, pattern: RegExp): Promise<boolean> {
  return page
    .getByText(pattern)
    .first()
    .isVisible()
    .catch(() => false);
}

const visible = (locator: Locator) => locator.first().isVisible().catch(() => false);

/** Estado por dois rótulos exclusivos (o botão muda de nome conforme a câmera). */
async function stateOf(on: Locator, off: Locator): Promise<CameraState | null> {
  if (await visible(on)) return "on";
  if (await visible(off)) return "off";
  return null;
}

function control(name: string, locator: Locator): JoinControl {
  return {
    name,
    visible: () => locator.first().isVisible(),
    act: () => locator.first().click({ timeout: 2000 }),
  };
}

function screenFor(
  page: Page,
  parts: {
    dismiss: JoinControl[];
    nameInput: Locator;
    mute: JoinControl[];
    camera: JoinScreen["camera"];
    join: Locator;
    driver: Pick<PlatformDriver, "isDenied" | "isInvalidLink">;
  },
): JoinScreen {
  const name = parts.nameInput.first();
  const join = parts.join.first();
  return {
    dismiss: parts.dismiss,
    nameInput: {
      visible: () => name.isVisible(),
      value: () => name.inputValue({ timeout: 1000 }),
      fill: (value) => name.fill(value, { timeout: 3000 }),
    },
    mute: parts.mute,
    camera: parts.camera,
    join: {
      visible: () => join.isVisible(),
      enabled: () => join.isEnabled({ timeout: 500 }),
      click: () => join.click({ timeout: 3000 }),
    },
    async failure() {
      if (await parts.driver.isInvalidLink(page)) return "Link de reunião inválido ou expirado.";
      if (await parts.driver.isDenied(page)) {
        return "A reunião não permite a entrada do bot (convidados bloqueados ou login exigido).";
      }
      return null;
    },
  };
}

// "Turn off camera" existe só com a câmera ligada; "Turn on camera", só com ela desligada.
const MEET_CAMERA_OFF = /^turn off camera|^desativar câmera/i;
const MEET_CAMERA_ON = /^turn on camera|^ativar câmera/i;

const meet: PlatformDriver = {
  async join(page, url, identity, opts, log) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const screen = screenFor(page, {
      dismiss: [
        control("entendi", page.getByRole("button", { name: /^(got it|entendi)$/i })),
        control(
          "continuar sem microfone",
          page.getByRole("button", { name: /continue without (microphone|mic)|continuar sem (microfone|mic)/i }),
        ),
      ],
      nameInput: page.getByRole("textbox", { name: /your name|seu nome/i }),
      mute: [control("microfone", page.getByRole("button", { name: /^turn off microphone|^desativar microfone/i }))],
      camera: {
        state: () => meet.cameraState(page),
        set: (on) => page.getByRole("button", { name: on ? MEET_CAMERA_ON : MEET_CAMERA_OFF }).first().click({ timeout: 2000 }),
      },
      join: page.getByRole("button", { name: /ask to join|join now|pedir para participar|participar agora/i }),
      driver: meet,
    });
    return driveJoin(screen, identity, { ...opts, log });
  },

  isInCall(page) {
    return page
      .getByRole("button", { name: /leave call|sair da chamada/i })
      .first()
      .isVisible()
      .catch(() => false);
  },

  isDenied(page) {
    return anyVisible(
      page,
      /you can't join this (video )?call|denied your request|removed from the (call|meeting)|sign in to join|não é possível participar|recusou seu pedido|removido da (chamada|reunião)|faça login para participar/i
    );
  },

  isInvalidLink(page) {
    return anyVisible(page, /check your meeting code|invalid video call name|verifique o código da reunião/i);
  },

  async ensureMuted(page) {
    await clickIfShown(page.getByRole("button", { name: /^turn off microphone|^desativar microfone/i }));
  },

  cameraState(page) {
    return stateOf(page.getByRole("button", { name: MEET_CAMERA_OFF }), page.getByRole("button", { name: MEET_CAMERA_ON }));
  },

  async setCamera(page, on) {
    await clickIfShown(page.getByRole("button", { name: on ? MEET_CAMERA_ON : MEET_CAMERA_OFF }));
  },

  isAlone(page) {
    return anyVisible(page, /you're the only one here|only one in the call|você é a única pessoa|único participante/i);
  },

  participantCount(page) {
    return countFrom(page.getByRole("button", { name: /people|participants|pessoas|participantes/i }));
  },

  hasEnded(page) {
    return anyVisible(
      page,
      /you('ve| have)? left the (meeting|call)|call ended|meeting (has )?ended|return to home screen|você saiu da (chamada|reunião)|a (chamada|reunião) (terminou|foi encerrada)/i,
    );
  },
};

const TEAMS_CAMERA_SWITCH = /camera|câmera|video|vídeo/i;
// Na chamada o botão diz o que o clique faz: "Turn camera off" com a câmera ligada.
const TEAMS_CAMERA_OFF = /^turn (camera off|off camera)|^desligar (a )?câmera/i;
const TEAMS_CAMERA_ON = /^turn (camera on|on camera)|^ligar (a )?câmera/i;

const teams: PlatformDriver = {
  async join(page, url, identity, opts, log) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const continueInBrowser = /continue on this browser|use the web app instead|join on the web|continuar neste navegador/i;
    const screen = screenFor(page, {
      dismiss: [
        control(
          "continuar no navegador",
          page.getByRole("button", { name: continueInBrowser }).or(page.getByRole("link", { name: continueInBrowser })),
        ),
        control(
          "continuar sem áudio ou vídeo",
          page.getByRole("button", { name: /continue without audio or video|continuar sem áudio ou vídeo/i }),
        ),
      ],
      nameInput: page.getByPlaceholder(/type your name|enter your name|digite seu nome/i),
      mute: [control("microfone", page.getByRole("switch", { name: /\bmic(rophone)?\b|microfone/i, checked: true }))],
      camera: {
        state: () =>
          stateOf(
            page.getByRole("switch", { name: TEAMS_CAMERA_SWITCH, checked: true }),
            page.getByRole("switch", { name: TEAMS_CAMERA_SWITCH, checked: false }),
          ),
        set: (on) =>
          page.getByRole("switch", { name: TEAMS_CAMERA_SWITCH, checked: !on }).first().click({ timeout: 2000 }),
      },
      join: page.getByRole("button", { name: /join now|entrar agora|ingressar agora/i }),
      driver: teams,
    });
    return driveJoin(screen, identity, { ...opts, log });
  },

  isInCall(page) {
    return page
      .getByRole("button", { name: /^(leave|sair)\b/i })
      .first()
      .isVisible()
      .catch(() => false);
  },

  isDenied(page) {
    return anyVisible(
      page,
      /denied access to the meeting|you've been removed|no one responded to your request|acesso negado|você foi removido|ninguém respondeu/i
    );
  },

  isInvalidLink(page) {
    return anyVisible(page, /meeting (link )?(is )?(invalid|expired)|couldn't find (the|this) meeting|link (da reunião )?inválido|reunião não encontrada/i);
  },

  // Rótulo "Mute ..." só existe enquanto o mic está ligado, então o clique
  // nunca desfaz um mudo.
  async ensureMuted(page) {
    await clickIfShown(page.getByRole("button", { name: /^mute\b|^desativar (o )?(som|mic)/i }));
  },

  cameraState(page) {
    return stateOf(page.getByRole("button", { name: TEAMS_CAMERA_OFF }), page.getByRole("button", { name: TEAMS_CAMERA_ON }));
  },

  async setCamera(page, on) {
    await clickIfShown(page.getByRole("button", { name: on ? TEAMS_CAMERA_ON : TEAMS_CAMERA_OFF }));
  },

  isAlone(page) {
    return anyVisible(page, /waiting for others to join|you're the only one here|aguardando outras pessoas|você é o único/i);
  },

  participantCount(page) {
    return countFrom(page.getByRole("button", { name: /^(people|pessoas)\b/i }));
  },

  hasEnded(page) {
    return anyVisible(
      page,
      /you left the meeting|meeting (has )?ended|call ended|you were removed|você saiu da reunião|a reunião (terminou|foi encerrada)/i,
    );
  },
};

export const drivers = { meet, teams } as const;
