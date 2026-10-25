import { defineConfig } from "vitest/config";
import path from "path";
// `server-only` throws outside a Server Component bundle; tests import server modules directly
const alias = { "@": path.resolve(__dirname), "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts") };
export default defineConfig({
  // tsconfig keeps "jsx": "preserve" for Next; the unit tests that render components to static markup need the automatic runtime
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    projects: [
      { resolve: { alias }, oxc: { jsx: { runtime: "automatic" } }, test: { name: "unit", include: ["tests/unit/**/*.test.{ts,tsx}"], setupFiles: ["dotenv/config"] } },
      // db tests need a throwaway Postgres; globalSetup is wired here only so test:unit never starts one
      // All db test files share ONE throwaway PostgreSQL and a few of them COMMIT rows or rely on global state (sequences, advisory locks, the outbox), so
      // they must never run side by side: one file at a time in one worker, whatever flags the caller passes. 30 s timeouts give a slow disk or a busy
      // CI machine room beyond the 5 s default.
      { resolve: { alias }, test: { name: "db", include: ["tests/db/**/*.test.ts"], globalSetup: ["tests/db/global-setup.ts"], setupFiles: ["dotenv/config"], fileParallelism: false, maxWorkers: 1, testTimeout: 30000, hookTimeout: 30000 } },
    ],
  },
});
