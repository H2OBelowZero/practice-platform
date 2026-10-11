import { NextResponse, type NextRequest } from "next/server";
import { homeFor } from "@/lib/auth/roles";
import { safeNext } from "@/lib/auth/redirect";
import { audit } from "@/lib/audit";
import { currentUser } from "@/lib/auth/session";
import { clearAuthCookies, supabaseServer } from "@/lib/supabase/server";

/** Email links (signup confirmation, password recovery) land here with a one-time `code` (PKCE). */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  if (code) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (!error) {
      try {
        await audit("auth.login", "session", undefined, { via: "callback" }, sb); // no verified user -> nothing written
      } catch {
        try { await sb.auth.signOut({ scope: "local" }); } catch {}
        await clearAuthCookies(); // fail closed, as in signIn
        return NextResponse.redirect(new URL("/login?error=link", origin));
      }
      const requested = searchParams.get("next");
      const me = requested ? null : await currentUser(sb);
      return NextResponse.redirect(new URL(safeNext(requested, me ? homeFor(me.role) : "/login"), origin));
    }
  }
  return NextResponse.redirect(new URL("/login?error=link", origin));
}
