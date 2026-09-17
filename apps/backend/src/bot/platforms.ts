import { Locator, Page } from "playwright";
import { driveJoin, JoinControl, JoinOptions, JoinScreen } from "./join";

/**
 * Seletores de cada plataforma num lugar só. Meet e Teams mudam a UI sem
 * aviso — quando o bot parar de entrar, olhe o screenshot de debug da
 * reunião na interface e ajuste aqui.
 */
export interface PlatformDriver {
  /** Abre o link e envia o pedido de entrada; `onJoining` marca a chegada na tela de pré-entrada. */
  join(page: Page, url: string, botName: string, opts: Omit<JoinOptions, "log">, log: (msg: string) => void): Promise<void>;
  isInCall(page: Page): Promise<boolean>;
  isDenied(page: Page): Promise<boolean>;
  isInvalidLink(page: Page): Promise<boolean>;
  ensureMuted(page: Page): Promise<void>;
  isAlone(page: Page): Promise<boolean>;
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
    toggles: JoinControl[];
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
    toggles: parts.toggles,
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

const meet: PlatformDriver = {
  async join(page, url, botName, opts, log) {
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
      toggles: [
        control("microfone", page.getByRole("button", { name: /^turn off microphone|^desativar microfone/i })),
        control("câmera", page.getByRole("button", { name: /^turn off camera|^desativar câmera/i })),
      ],
      join: page.getByRole("button", { name: /ask to join|join now|pedir para participar|participar agora/i }),
      driver: meet,
    });
    await driveJoin(screen, botName, { ...opts, log });
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
    await clickIfShown(page.getByRole("button", { name: /^turn off camera|^desativar câmera/i }));
  },

  isAlone(page) {
    return anyVisible(page, /you're the only one here|only one in the call|você é a única pessoa|único participante/i);
  },
};

const teams: PlatformDriver = {
  async join(page, url, botName, opts, log) {
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
      toggles: [
        control("câmera", page.getByRole("switch", { name: /camera|câmera|video|vídeo/i, checked: true })),
        control("microfone", page.getByRole("switch", { name: /\bmic(rophone)?\b|microfone/i, checked: true })),
      ],
      join: page.getByRole("button", { name: /join now|entrar agora|ingressar agora/i }),
      driver: teams,
    });
    await driveJoin(screen, botName, { ...opts, log });
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
    await clickIfShown(page.getByRole("button", { name: /^turn camera off|^desligar câmera/i }));
  },

  isAlone(page) {
    return anyVisible(page, /waiting for others to join|you're the only one here|aguardando outras pessoas|você é o único/i);
  },
};

export const drivers = { meet, teams } as const;
