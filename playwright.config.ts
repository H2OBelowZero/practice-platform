import { defineConfig, devices } from "@playwright/test";
import { e2eReady, SKIP_MESSAGE } from "./tests/e2e/helpers/roles";

// End-to-end tests need a running app AND a Supabase project seeded with supabase/seed.sql (README: "Running the end-to-end tests").
//   E2E_BASE_URL              the app (default http://localhost:3000)
//   E2E_START_SERVER=1        start `npm run dev` for the run (otherwise start or deploy the app yourself)
//   E2E_SUPABASE_URL / E2E_SUPABASE_ANON_KEY / E2E_SUPABASE_SERVICE_KEY   the project the app talks to
//   E2E_PAYFAST_PASSPHRASE, E2E_PAYFAST_MERCHANT_ID   optional: enable the "signed notification from a non-PayFast address is refused" check
// Without the Supabase variables global setup does nothing and every spec that needs the project skips itself, so `npx playwright test`
// passes (all skipped) on a machine with no project. Set E2E_REQUIRE=1 (CI, staging gates) to make a missing environment FAIL the run instead.
const ready = e2eReady();
if (!ready && !process.env.TEST_WORKER_INDEX && !process.env.E2E_QUIET) console.warn(`\n${SKIP_MESSAGE()}\nSpecs that need it will be skipped.\n`);

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false, // the specs share one database
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],
  globalSetup: "./tests/e2e/global-setup.ts", // does nothing without the E2E variables, or fails when E2E_REQUIRE=1
  use: { baseURL, trace: "on-first-retry", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"] } },
    // the phone-width pass runs only the specs/tests tagged @mobile (read-only checks of key screens at 375 x 812)
    { name: "chromium-mobile", grep: /@mobile/, use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true } },
  ],
  webServer: process.env.E2E_START_SERVER === "1" ? { command: "npm run dev", url: baseURL, reuseExistingServer: true, timeout: 120_000 } : undefined,
});
