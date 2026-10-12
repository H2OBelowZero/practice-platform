import { emailProviderName, smsActive, type EmailProviderName } from "@/lib/notify/provider";
import { payfastAvailable } from "@/lib/payments/payfast";

/**
 * What the integrations panel may say about the environment: yes/no answers and a few fixed words. NEVER a value. The only text taken from the environment
 * is the HOST of the Supabase URL (not secret, and it helps the owner confirm the right project). Every field here is a boolean or one of a fixed set of words,
 * so a secret cannot slip into the page by accident (tests/unit/settings-env-status.test.ts renders it with recognisable secrets and looks for them).
 */
export type IntegrationStatus = {
  email: { configured: boolean; provider: EmailProviderName };
  sms: { active: boolean };
  payfast: { configured: boolean; mode: "sandbox" | "live"; passphraseSet: boolean; merchantSet: boolean };
  cronSecretSet: boolean;
  appUrlSet: boolean;
  supabaseHost: string | null;
};

export const PAYFAST_NOTIFY_PATH = "/api/payfast/itn"; // the path only: the full URL starts with APP_URL

type Env = Record<string, string | undefined>;
const set = (v: string | undefined): boolean => !!v && v.trim() !== "";

export function supabaseHost(url: string | undefined): string | null {
  if (!set(url)) return null;
  try { return new URL(url!.trim()).host; } catch { return null; }
}

export function integrationStatus(env: Env = process.env): IntegrationStatus {
  const provider = emailProviderName(env as NodeJS.ProcessEnv);
  return {
    email: { configured: provider === "resend", provider },
    sms: { active: smsActive(env as NodeJS.ProcessEnv) },
    payfast: {
      configured: payfastAvailable(env),
      mode: env.PAYFAST_SANDBOX === "true" ? "sandbox" : "live",
      passphraseSet: set(env.PAYFAST_PASSPHRASE),
      merchantSet: set(env.PAYFAST_MERCHANT_ID) && set(env.PAYFAST_MERCHANT_KEY),
    },
    cronSecretSet: set(env.CRON_SECRET),
    appUrlSet: set(env.APP_URL),
    supabaseHost: supabaseHost(env.NEXT_PUBLIC_SUPABASE_URL),
  };
}

/** The last cron run, from its audit row (counts and codes only). A quiet run leaves no row, so "none" means "nothing happened recently", not "never ran". */
export type CronRun = { at: string; ok: boolean | null; errors: number } | null;
export function cronRunFrom(row: { at: string; detail: unknown } | null | undefined): CronRun {
  if (!row?.at) return null;
  const d = (row.detail && typeof row.detail === "object" ? row.detail : {}) as { ok?: unknown; errors?: unknown };
  return { at: row.at, ok: typeof d.ok === "boolean" ? d.ok : null, errors: Array.isArray(d.errors) ? d.errors.length : 0 };
}
