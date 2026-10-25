// `npm run test:e2e [playwright args]`: explains what is needed when the environment is missing, then runs Playwright anyway
// (without the environment every spec that needs Supabase skips itself, so the run still exits 0).
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const need = ["E2E_SUPABASE_URL", "E2E_SUPABASE_ANON_KEY", "E2E_SUPABASE_SERVICE_KEY"];
const missing = need.filter((v) => !process.env[v]);
if (missing.length) {
  console.log(
    `\nNo end-to-end environment (missing: ${missing.join(", ")}).\n` +
    "The e2e specs need a running app and a Supabase project loaded with supabase/seed.sql; they will be SKIPPED, not run.\n" +
    'See README, "Running the end-to-end tests" (staging project or local `supabase start`).\n',
  );
}
const cli = createRequire(import.meta.url).resolve("@playwright/test/cli");
const r = spawnSync(process.execPath, [cli, "test", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
