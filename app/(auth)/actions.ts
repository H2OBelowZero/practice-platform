"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { homeFor, needsMfa } from "@/lib/auth/roles";
import { safeNext } from "@/lib/auth/redirect";
import { currentUser, requireRecoverySession } from "@/lib/auth/session";
import { appUrl } from "@/lib/app-url";
import { clearAuthCookies, supabaseServer } from "@/lib/supabase/server";

// Every action takes untrusted FormData: parse with Zod first. Passwords and codes are never logged or put in URLs.

export type FormState = {
  error?: string;
  email?: string;
  done?: boolean;
  enrol?: { factorId: string; qr: string; secret: string };
} | null;

/** Fail-closed exit: end the session on this device and drop the cookies even if signOut itself fails. */
async function dropSession(sb: Awaited<ReturnType<typeof supabaseServer>>) {
  try { await sb.auth.signOut({ scope: "local" }); } catch { /* cookies are cleared below regardless */ }
  await clearAuthCookies();
}

const LOGIN_FAILED = "Email or password is incorrect."; // same text for unknown email, wrong password, unconfirmed account
const email = z.string().trim().pipe(z.email().max(254));
const raw = (fd: FormData) => Object.fromEntries(fd);

// ---- sign in / out -----------------------------------------------------------------------------------------------------------

const signInSchema = z.object({ email, password: z.string().min(1).max(256), next: z.string().max(1024).optional() });

export async function signIn(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = signInSchema.safeParse(raw(formData));
  if (!parsed.success) return { error: "Enter your email address and password.", email: String(formData.get("email") ?? "").slice(0, 254) };
  const { password, next } = parsed.data;
  const mail = parsed.data.email.toLowerCase();

  const sb = await supabaseServer();
  const { error } = await sb.auth.signInWithPassword({ email: mail, password });
  if (error) {
    // Never reveal whether the account exists; only a rate limit gets its own wording (it says nothing about the account).
    return { error: error.status === 429 ? "Too many attempts. Wait a few minutes and try again." : LOGIN_FAILED, email: mail };
  }
  const me = await currentUser(sb);
  if (!me) { // authenticated but has no profile: treat as a failed sign-in
    await dropSession(sb);
    return { error: LOGIN_FAILED, email: mail };
  }
  try {
    await audit("auth.login", "session", undefined, undefined, sb);
  } catch {
    await dropSession(sb); // fail closed: no un-audited sessions
    return { error: "Sign-in is temporarily unavailable. Try again shortly.", email: mail };
  }
  const dest = safeNext(next, homeFor(me.role));
  // Staff must complete TOTP (aal2) before reaching anything; /mfa then continues to `dest`.
  redirect(needsMfa(me.role) ? `/mfa?next=${encodeURIComponent(dest)}` : dest);
}

/** No inputs. Audits the logout while the session is still valid, then ends it. */
export async function signOut(): Promise<void> {
  const sb = await supabaseServer();
  try { await audit("auth.logout", "session", undefined, undefined, sb); }
  catch { console.error("audit auth.logout failed"); } // never block a sign-out on the audit write
  await sb.auth.signOut();
  redirect("/login");
}

// ---- registration ------------------------------------------------------------------------------------------------------------
// Creates a PATIENT account only (the signup trigger ignores any role: 0006). Records no consent of any kind (spec section 6).

const registerSchema = z.object({
  name: z.string().trim().min(1, "Enter your full name.").max(100, "Use at most 100 characters for your name."),
  email,
  password: z.string().min(12, "Use at least 12 characters for your password.").max(72, "Use at most 72 characters for your password."),
  next: z.string().max(1024).optional(),
});

export async function register(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = registerSchema.safeParse(raw(formData));
  if (!parsed.success) {
    return { error: parsed.error.issues[0].message, email: String(formData.get("email") ?? "").slice(0, 254) };
  }
  const { name, password, next } = parsed.data;
  const mail = parsed.data.email.toLowerCase();
  const safe = safeNext(next, "");
  // After the emailed link is used, /auth/callback sends the person on to `next` (e.g. the booking they were making).
  const emailRedirectTo = `${appUrl()}/auth/callback${safe ? `?next=${encodeURIComponent(safe)}` : ""}`;

  const sb = await supabaseServer();
  const { error } = await sb.auth.signUp({ email: mail, password, options: { emailRedirectTo, data: { name } } });
  if (error) {
    if (error.status === 429) return { error: "Too many attempts. Wait a few minutes and try again.", email: mail };
    if (error.code === "weak_password") return { error: "That password is too easy to guess. Choose a longer, less common one.", email: mail };
    // Anything else (including "already registered") gets the same answer as success: the response must not reveal whether an account exists.
    console.error("signUp failed:", error.status, error.code);
  }
  return { done: true };
}

// ---- password recovery -------------------------------------------------------------------------------------------------------

export async function requestRecovery(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = z.object({ email }).safeParse(raw(formData));
  if (!parsed.success) return { error: "Enter a valid email address." };
  const redirectTo = `${appUrl()}/auth/callback?next=/recover/reset`; // throws loudly in production if APP_URL is unset
  try {
    const sb = await supabaseServer();
    await sb.auth.resetPasswordForEmail(parsed.data.email.toLowerCase(), { redirectTo });
  } catch { /* ignored on purpose: the response must not depend on whether the account exists */ }
  return { done: true };
}

const resetSchema = z.object({
  password: z.string().min(12, "Use at least 12 characters.").max(72, "Use at most 72 characters."),
  confirm: z.string(),
}).refine((d) => d.password === d.confirm, { message: "The two passwords do not match.", path: ["confirm"] });

export async function resetPassword(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = resetSchema.safeParse(raw(formData));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { sb } = await requireRecoverySession(); // fresh recovery link only; staff must be aal2
  const { error } = await sb.auth.updateUser({ password: parsed.data.password });
  if (error) return { error: "That password could not be used. Choose a different one (at least 12 characters)." };
  try { await audit("auth.password_reset", "session", undefined, undefined, sb); }
  catch { console.error("audit auth.password_reset failed"); }
  await sb.auth.signOut(); // force a fresh sign-in (and TOTP for staff) with the new password
  redirect("/login?reset=1");
}

// ---- MFA (TOTP, staff only) --------------------------------------------------------------------------------------------------

/** Creates a fresh, unverified TOTP factor and returns its QR + secret for the signed-in staff user. */
export async function startMfaEnrolment(): Promise<FormState> {
  const sb = await supabaseServer();
  const me = await currentUser(sb);
  if (!me || !needsMfa(me.role)) return { error: "You need to be signed in as staff to set up two-step verification." };
  const { data: factors } = await sb.auth.mfa.listFactors();
  if (factors?.totp.length) return { error: "An authenticator app is already set up. Reload this page to enter a code." };
  for (const f of factors?.all ?? []) if (f.status === "unverified") await sb.auth.mfa.unenroll({ factorId: f.id }); // abandoned attempts
  const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", issuer: "Practice Platform" });
  if (error || !data) return { error: "Could not start setup. Try again." };
  return { enrol: { factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret } };
}

const verifySchema = z.object({
  factorId: z.uuid(),
  code: z.string().trim().transform((s) => s.replace(/\s/g, "")).pipe(z.string().regex(/^\d{6}$/)),
  next: z.string().max(1024).optional(),
});

/** Challenge + verify a TOTP code; on success the session becomes aal2 and the user continues to their area. */
export async function verifyMfa(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = verifySchema.safeParse(raw(formData));
  if (!parsed.success) return { error: "Enter the 6-digit code from your authenticator app." };
  const sb = await supabaseServer();
  const me = await currentUser(sb);
  if (!me || !needsMfa(me.role)) redirect("/login");
  const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: parsed.data.factorId, code: parsed.data.code });
  if (error) return { error: "That code is not correct or has expired. Check the code and try again." };
  try { await audit("auth.mfa_verify", "session", undefined, undefined, sb); }
  catch { console.error("audit auth.mfa_verify failed"); }
  redirect(safeNext(parsed.data.next, homeFor(me.role)));
}
