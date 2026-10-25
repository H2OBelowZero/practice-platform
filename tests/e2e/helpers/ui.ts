import { expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { AUTH_DIR, PASSWORD, ROLES, type RoleName } from "./roles";
import { secondsLeft, totp } from "./totp";

// Small shared actions. Selectors are role / label based and match the pages as built (see the older specs for the same strings).

/** Wait out the last second of a 30 s TOTP window so the code cannot expire between computing it and the server checking it. */
async function freshCode(secret: string): Promise<string> {
  if (secondsLeft() <= 2) await new Promise((r) => setTimeout(r, 3000));
  return totp(secret);
}

function readSecret(file: string): string | null {
  if (!existsSync(file)) return null;
  try { return (JSON.parse(readFileSync(file, "utf8")) as { secret?: string }).secret ?? null; } catch { return null; }
}

/**
 * Sign in through the real /login page. Staff are then sent to /mfa: first time, set up the authenticator (the page shows the secret
 * key as text; it is saved to tests/e2e/.auth/totp-<role>.json for later runs); afterwards enter a code from the saved secret.
 * Resolves on the role's home area.
 */
export async function signInAs(page: Page, name: RoleName, opts: { email?: string; password?: string } = {}) {
  const r = ROLES[name];
  await page.goto("/login");
  await page.getByLabel("Email address").fill(opts.email ?? r.email);
  await page.getByLabel("Password").fill(opts.password ?? PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  if (!r.staff) { await page.waitForURL(r.home); return; }

  await page.waitForURL(/\/mfa|\/app/);
  if (/\/app/.test(page.url())) return; // already aal2 (not expected on a fresh context)
  mkdirSync(AUTH_DIR, { recursive: true });
  let secret = readSecret(r.totpFile);
  if (!secret) {
    if (!(await page.getByRole("button", { name: "Set up authenticator app" }).isVisible())) {
      throw new Error(`${r.email} already has an authenticator but ${r.totpFile} does not exist. Remove the factor in the Supabase dashboard (Authentication > Users > the user > Factors) or re-seed, then run again.`);
    }
    await page.getByRole("button", { name: "Set up authenticator app" }).click();
    const key = page.locator("code").first();
    await expect(key).toBeVisible();
    secret = ((await key.textContent()) ?? "").trim();
    if (!/^[A-Z2-7]{16,}$/.test(secret)) throw new Error(`could not read the authenticator key from /mfa (got "${secret}")`);
    writeFileSync(r.totpFile, JSON.stringify({ email: r.email, secret }, null, 2));
  }
  await page.getByLabel("6-digit code").fill(await freshCode(secret));
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await page.waitForURL(/\/app/);
}

/** A new browser context already signed in as `name` (storage state written by global setup). */
export async function contextFor(browser: Browser, name: RoleName): Promise<BrowserContext> {
  const state = ROLES[name].state;
  if (!existsSync(state)) throw new Error(`no stored sign-in for ${name} (${state}); global setup creates it when the E2E environment is set`);
  return browser.newContext({ storageState: state });
}
export async function pageFor(browser: Browser, name: RoleName): Promise<Page> {
  return (await contextFor(browser, name)).newPage();
}

/** A visible notice/banner on the page (the app renders them with role=status or role=alert). */
export async function expectBanner(page: Page, text: string | RegExp) {
  await expect(page.locator('[role="status"], [role="alert"]').filter({ hasText: text }).first()).toBeVisible();
}

/** Pick a session type, date and the first free time on the public booking page (signed in or not). */
export async function pickFirstSlot(page: Page, sessionType: RegExp, dateIso: string) {
  await page.goto("/book");
  await page.getByRole("button", { name: sessionType }).click();
  await page.getByLabel("Date").fill(dateIso);
  await page.getByRole("button", { name: "Show available times" }).click();
  await page.getByRole("button", { name: /^\d{2}:\d{2}$/ }).first().click();
}

/** A Monday-Friday date at least `minDays` away (YYYY-MM-DD). Inside the 60 day booking horizon for any sensible minDays. */
export function weekdayFrom(minDays: number): string {
  const d = new Date(Date.now() + minDays * 86_400_000);
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** "R 1 234,50" the way the app writes money, from cents. */
export function zar(cents: number): string {
  const rand = Math.floor(cents / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `R ${rand},${String(cents % 100).padStart(2, "0")}`;
}
