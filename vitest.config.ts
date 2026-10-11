import { defineConfig } from "vitest/config";
import path from "path";
const alias = { "@": path.resolve(__dirname) };
export default defineConfig({
  test: {
    environment: "node",
    projects: [
      { resolve: { alias }, test: { name: "unit", include: ["tests/unit/**/*.test.ts"], setupFiles: ["dotenv/config"] } },
      // db tests need a throwaway Postgres; globalSetup is wired here only so test:unit never starts one
      { resolve: { alias }, test: { name: "db", include: ["tests/db/**/*.test.ts"], globalSetup: ["tests/db/global-setup.ts"], setupFiles: ["dotenv/config"] } },
    ],
  },
});
