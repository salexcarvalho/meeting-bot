import { describe, expect, it } from "vitest";
import { Extracao } from "@meeting-bot/contracts";
import { LlmQueue } from "../src/llm/provider";
import { toJsonSchema } from "../src/llm/schema";

describe("toJsonSchema", () => {
  it("remove limites de tamanho e mantém enums/required", () => {
    const schema = toJsonSchema(Extracao) as any;
    const text = JSON.stringify(schema);
    expect(text).not.toContain("maxLength");
    expect(text).not.toContain("maxItems");
    expect(text).not.toContain("$schema");
    expect(schema.required).toEqual(["resumo_trecho", "itens"]);
    expect(schema.properties.itens.items.properties.tipo.enum).toContain("decisao_arquitetural");
  });

  it("com limits mantém os tamanhos máximos", () => {
    expect(JSON.stringify(toJsonSchema(Extracao, { limits: true }))).toContain("maxItems");
  });
});

describe("LlmQueue", () => {
  it("executa uma por vez e prioriza live", async () => {
    const queue = new LlmQueue();
    const order: string[] = [];
    let release!: () => void;
    const first = queue.run("post", async () => {
      order.push("post-1");
      await new Promise<void>((r) => (release = r));
    });
    const second = queue.run("post", async () => void order.push("post-2"));
    const live = queue.run("live", async () => void order.push("live"));
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toEqual(["post-1"]);
    release();
    await Promise.all([first, second, live]);
    expect(order).toEqual(["post-1", "live", "post-2"]);
  });
});
