import { describe, expect, it, vi } from "vitest";
import { gotoWithRetry, isTransientNetworkError } from "../src/bot/navigate";

const timeout = () => new Error("page.goto: net::ERR_TIMED_OUT at https://teams.microsoft.com/l/meetup-join/x");

describe("erros de rede que passam sozinhos", () => {
  it("reconhece queda de rede e não confunde com erro de página", () => {
    for (const code of ["TIMED_OUT", "NAME_NOT_RESOLVED", "INTERNET_DISCONNECTED", "NETWORK_CHANGED", "CONNECTION_RESET"]) {
      expect(isTransientNetworkError(`page.goto: net::ERR_${code} at https://x`)).toBe(true);
    }
    expect(isTransientNetworkError("page.goto: net::ERR_CERT_AUTHORITY_INVALID at https://x")).toBe(false);
    expect(isTransientNetworkError("Tempo esgotado ao entrar na reunião (o botão de entrar não apareceu).")).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
  });
});

describe("gotoWithRetry", () => {
  const sleep = vi.fn(async (_ms: number) => {});

  it("repete depois de queda de rede e segue quando a rede volta", async () => {
    sleep.mockClear();
    const goto = vi.fn().mockRejectedValueOnce(timeout()).mockRejectedValueOnce(timeout()).mockResolvedValueOnce(null);
    const log = vi.fn();
    await gotoWithRetry({ goto }, "https://x", { sleep, log });
    expect(goto).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([5_000, 15_000]);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it("desiste na terceira falha e devolve o erro original", async () => {
    const goto = vi.fn().mockRejectedValue(timeout());
    await expect(gotoWithRetry({ goto }, "https://x", { sleep })).rejects.toThrow(/ERR_TIMED_OUT/);
    expect(goto).toHaveBeenCalledTimes(3);
  });

  it("erro que não é de rede não repete", async () => {
    const goto = vi.fn().mockRejectedValue(new Error("page.goto: net::ERR_CERT_AUTHORITY_INVALID"));
    await expect(gotoWithRetry({ goto }, "https://x", { sleep })).rejects.toThrow(/CERT/);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it("cancelado no meio: não repete", async () => {
    const goto = vi.fn().mockRejectedValue(timeout());
    const controller = new AbortController();
    controller.abort();
    await expect(gotoWithRetry({ goto }, "https://x", { sleep, signal: controller.signal })).rejects.toThrow();
    expect(goto).toHaveBeenCalledTimes(1);
  });
});
