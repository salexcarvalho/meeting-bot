import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { createLoginLimiter } from "../src/security/loginLimiter";

let server: Server | null = null;

afterEach(async () => {
  await new Promise((resolve) => (server ? server.close(resolve) : resolve(null)));
  server = null;
});

async function start(limit: number): Promise<{ url: string; audited: string[] }> {
  const audited: string[] = [];
  const app = express();
  app.use(express.json());
  app.post(
    "/login",
    createLoginLimiter((req) => void audited.push(String(req.body?.username)), { limit }),
    (_req, res) => res.status(401).json({ error: "inválido" }),
  );
  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/login`, audited };
}

const post = (url: string) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ana" }) });

describe("limite de tentativas de login", () => {
  it("auditoria só na primeira requisição bloqueada da janela (flood de 429 gera 1 linha)", async () => {
    const { url, audited } = await start(3);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await post(url)).status);
    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses.slice(3).every((s) => s === 429)).toBe(true);
    expect(audited).toEqual(["ana"]);
  });

  it("falha na auditoria não derruba a resposta 429 em loop: vira erro de rota", async () => {
    const app = express();
    app.use(express.json());
    app.post("/login", createLoginLimiter(() => Promise.reject(new Error("db")), { limit: 1 }), (_req, res) => res.status(401).end());
    server = createServer(app);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/login`;
    await post(url);
    expect((await post(url)).status).toBe(500);
    expect((await post(url)).status).toBe(429);
  });
});
