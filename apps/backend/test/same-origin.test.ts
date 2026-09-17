import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { requireSameOrigin } from "../src/auth";

function run(method: string, headers: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { method, get: (name: string) => lower[name.toLowerCase()] } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  requireSameOrigin(req, res, next);
  return { passed: (next as unknown as { mock: { calls: unknown[] } }).mock.calls.length === 1, res };
}

const host = { host: "127.0.0.1:3000" };

describe("requireSameOrigin", () => {
  it("libera leituras", () => {
    expect(run("GET", { ...host, origin: "https://evil.example" }).passed).toBe(true);
  });

  it("confere Origin quando presente", () => {
    expect(run("POST", { ...host, origin: "http://127.0.0.1:3000" }).passed).toBe(true);
    const denied = run("POST", { ...host, origin: "https://evil.example" });
    expect(denied.passed).toBe(false);
    expect(denied.res.status).toHaveBeenCalledWith(403);
    expect(run("POST", { ...host, origin: "null" }).passed).toBe(false);
  });

  it("sem Origin, usa Sec-Fetch-Site", () => {
    expect(run("PATCH", { ...host, "sec-fetch-site": "same-origin" }).passed).toBe(true);
    expect(run("PATCH", { ...host, "sec-fetch-site": "cross-site" }).passed).toBe(false);
    expect(run("PATCH", { ...host, "sec-fetch-site": "same-site", referer: "http://127.0.0.1:3000/x" }).passed).toBe(false);
  });

  it("sem Origin nem Sec-Fetch-Site, usa Referer", () => {
    expect(run("DELETE", { ...host, referer: "http://127.0.0.1:3000/reunioes" }).passed).toBe(true);
    expect(run("DELETE", { ...host, referer: "https://evil.example/page" }).passed).toBe(false);
  });

  it("cliente sem cabeçalhos de navegador passa (curl)", () => {
    expect(run("POST", host).passed).toBe(true);
  });
});
