import { expect, test } from "@playwright/test";
import { ANA, login, seedMeeting, shot, withDb } from "./tarefas-helpers";

// Nome dos falantes pela chamada (specs/006, T055): reunião semeada com falantes automáticos e manuais.
// Usa a Ana criada por plataforma.spec.ts (este arquivo roda depois, em ordem alfabética).
const TITLE = `Reunião dos falantes ${Date.now()}`;

async function seed(): Promise<string> {
  const meetingId = await seedMeeting("e2e-ana", TITLE);
  await withDb(async (db) => {
    let t = 10;
    for (let round = 0; round < 5; round++) {
      for (const [label, key, name] of [["Speaker 1", "id:a", "Maria Souza"], ["Speaker 2", "id:b", "João Lima"]]) {
        await db.query(
          `INSERT INTO transcript_segments (meeting_id, channel, pass, speaker, text, start_seconds, end_seconds)
           VALUES ($1, 'mixed', 'final', $2, 'fala', $3, $4)`,
          [meetingId, label, t + 0.2, t + 7.8],
        );
        await db.query(
          `INSERT INTO speaker_activity (meeting_id, participant_key, display_name, platform, start_seconds, end_seconds)
           VALUES ($1, $2, $3, 'teams', $4, $5)`,
          [meetingId, key, name, t, t + 8],
        );
        t += 9;
      }
    }
    await db.query(`INSERT INTO meeting_speakers (meeting_id, label, display_name) VALUES ($1, 'Speaker 1', 'Speaker 1'), ($1, 'Speaker 2', 'Speaker 2')`, [meetingId]);
    await db.query(`UPDATE meetings SET speaker_timeline_meta = '{"status":"ok","people":2,"intervals":10}' WHERE id = $1`, [meetingId]);
  });
  return meetingId;
}

test.describe.serial("nomes dos falantes na reunião", () => {
  let meetingId = "";

  test.beforeAll(async () => {
    meetingId = await seed();
  });

  test("reaplicar nomes da chamada mostra origem e confiança; renomear vira manual e reaplicar respeita", async ({ page }) => {
    await login(page, ANA);
    await page.goto(`/reunioes/${meetingId}`);
    const speakers = page.locator("section.card", { has: page.getByRole("heading", { name: "Falantes" }) });
    await expect(speakers.getByText("Speaker 1", { exact: true })).toBeVisible();

    await speakers.getByRole("button", { name: "Reaplicar nomes da chamada" }).click();
    await expect(speakers.getByText("Maria Souza")).toBeVisible();
    await expect(speakers.getByText("João Lima")).toBeVisible();
    await expect(speakers.getByText("da chamada", { exact: true })).toHaveCount(2);
    await expect(speakers.getByText("alta", { exact: true })).toHaveCount(2);
    await shot(page, "falantes-chamada");

    await speakers.getByRole("button", { name: "Renomear" }).nth(1).click();
    await page.getByLabel("Nome de Speaker 2").fill("Dr. Paulo");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(speakers.getByText("Dr. Paulo")).toBeVisible();
    await expect(speakers.getByText("manual", { exact: true })).toBeVisible();

    await speakers.getByRole("button", { name: "Reaplicar nomes da chamada" }).click();
    await expect(speakers.getByText("Dr. Paulo")).toBeVisible();
    await expect(speakers.getByText("João Lima")).toHaveCount(0);

    await speakers.getByRole("button", { name: "Voltar a Speaker 2" }).click();
    await expect(speakers.getByText("Dr. Paulo")).toHaveCount(0);
    await expect(speakers.getByText("Speaker 2").first()).toBeVisible();
  });

  test("leitura indisponível mostra o aviso e o falante continua como Speaker N", async ({ page }) => {
    await withDb((db) =>
      db.query(
        `UPDATE meetings SET speaker_timeline_meta = '{"status":"unavailable","reason":"no_tiles","people":0,"intervals":0}' WHERE id = $1`,
        [meetingId],
      ),
    );
    await login(page, ANA);
    await page.goto(`/reunioes/${meetingId}`);
    await expect(page.getByText("Os nomes da chamada não estavam disponíveis nesta reunião")).toBeVisible();
    await expect(page.getByRole("button", { name: "Reaplicar nomes da chamada" })).toHaveCount(0);
  });
});
