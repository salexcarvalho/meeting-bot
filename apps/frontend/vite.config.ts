import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// O backend serve o build (mesma origem do cookie de sessão).
// Em dev, o Vite repassa /api (inclusive WebSocket) para o backend.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@meeting-bot/contracts": fileURLToPath(new URL("../../packages/contracts/src/index.ts", import.meta.url)),
    },
  },
  server: {
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", ws: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
