import { notFound, redirect } from "next/navigation";
import { homeFor, needsMfa } from "@/lib/auth/roles";
import { safeNext } from "@/lib/auth/redirect";
import { currentUser } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";
import { signOut } from "../actions";
import { MfaEnrol, MfaVerify } from "./mfa-forms";

export const metadata = { title: "Two-step verification - Practice Platform" };

export default async function MfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const sb = await supabaseServer();
  const me = await currentUser(sb);
  if (!me) redirect("/login");
  if (!needsMfa(me.role)) notFound(); // staff only

  const dest = safeNext((await searchParams).next, homeFor(me.role));
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal?.currentLevel === "aal2") redirect(dest);

  const { data: factors } = await sb.auth.mfa.listFactors();
  const factor = factors?.totp[0]; // verified TOTP factors only
  return (
    <>
      <h1 className="mb-2 text-2xl font-semibold">Two-step verification</h1>
      {factor ? (
        <>
          <p className="mb-4">Enter the 6-digit code from your authenticator app to continue.</p>
          <MfaVerify factorId={factor.id} next={dest} />
        </>
      ) : (
        <>
          <p className="mb-4">Staff accounts need an authenticator app (such as Google Authenticator, Microsoft Authenticator or Authy). Set it up once, then enter a code each time you sign in.</p>
          <MfaEnrol next={dest} />
        </>
      )}
      <form action={signOut} className="mt-6">
        <button type="submit" className="min-h-11 underline underline-offset-4">Sign out</button>
      </form>
    </>
  );
}
