import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // test/db/* só rodam com TEST_DATABASE_URL (npm run test:db); sem ela são pulados.
    passWithNoTests: false,
    fileParallelism: !process.env.TEST_DATABASE_URL,
    // config.ts exige estas variáveis.
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL || "postgres://teste:teste@127.0.0.1:1/teste",
      AGENT_TOKEN: "teste-".repeat(8),
      LOCAL_ONLY: "true",
      DATA_DIR: "/tmp/agente-reunioes-teste",
    },
  },
});
