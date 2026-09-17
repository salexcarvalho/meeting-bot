import { defineConfig, devices } from "@playwright/test";

// E2E contra o backend real + Postgres descartável (scripts/e2e.mjs sobe tudo e define E2E_BASE_URL).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: process.env.E2E_OUTPUT_DIR || "test-results",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://127.0.0.1:3310",
    locale: "pt-BR",
    timezoneId: "America/Sao_Paulo",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    // o cenário móvel usa os usuários criados pelo desktop
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/, dependencies: ["desktop"] },
  ],
});
