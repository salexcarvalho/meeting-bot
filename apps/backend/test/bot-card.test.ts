import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterAll, describe, expect, it } from "vitest";
import { CARD_HEIGHT, CARD_WIDTH, createCameraCard } from "../src/bot/card";

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)("ícone do agente na câmera", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "card-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("gera um quadro .y4m com o ícone no centro e apaga ao descartar", async () => {
    const icon = path.join(dir, "icone.png");
    execFileSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=300x200:d=1", "-frames:v", "1", icon]);
    const card = await createCameraCard(icon);
    const head = readFileSync(card.file).subarray(0, 64).toString("latin1");
    expect(head).toMatch(new RegExp(`^YUV4MPEG2 W${CARD_WIDTH} H${CARD_HEIGHT} F15:1`));

    // centro vermelho (ícone), canto escuro (fundo)
    const pixel = (x: number, y: number) =>
      execFileSync("ffmpeg", ["-loglevel", "error", "-i", card.file, "-vf", `format=rgb24,crop=2:2:${x}:${y}`, "-f", "rawvideo", "-"]).subarray(0, 3);
    const [r, g] = pixel(CARD_WIDTH / 2, CARD_HEIGHT / 2);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(60);
    expect(Math.max(...pixel(10, 10))).toBeLessThan(60);

    await card.dispose();
    expect(existsSync(path.dirname(card.file))).toBe(false);
  });

  it("imagem inválida falha sem deixar arquivo para trás", async () => {
    const bad = path.join(dir, "nao-e-imagem.png");
    execFileSync("sh", ["-c", `printf 'x' > '${bad}'`]);
    await expect(createCameraCard(bad)).rejects.toThrow(/ffmpeg/);
  });
});
