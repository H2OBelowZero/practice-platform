import { defineConfig } from "vitest/config";
import path from "path";
const alias = { "@": path.resolve(__dirname) };
export default defineConfig({
  // tsconfig keeps "jsx": "preserve" for Next; the unit tests that render components to static markup need the automatic runtime
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    projects: [
      { resolve: { alias }, oxc: { jsx: { runtime: "automatic" } }, test: { name: "unit", include: ["tests/unit/**/*.test.{ts,tsx}"], setupFiles: ["dotenv/config"] } },
      // db tests need a throwaway Postgres; globalSetup is wired here only so test:unit never starts one
      { resolve: { alias }, test: { name: "db", include: ["tests/db/**/*.test.ts"], globalSetup: ["tests/db/global-setup.ts"], setupFiles: ["dotenv/config"] } },
    ],
  },
});
