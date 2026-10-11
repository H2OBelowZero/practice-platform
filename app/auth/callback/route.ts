import { NextResponse, type NextRequest } from "next/server";
import { homeFor } from "@/lib/auth/roles";
import { safeNext } from "@/lib/auth/redirect";
import { currentUser } from "@/lib/auth/session";
import { supabaseServer } from "@/lib/supabase/server";

/** Email links (signup confirmation, password recovery) land here with a one-time `code` (PKCE). */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  if (code) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (!error) {
      const requested = searchParams.get("next");
      const me = requested ? null : await currentUser(sb);
      return NextResponse.redirect(new URL(safeNext(requested, me ? homeFor(me.role) : "/login"), origin));
    }
  }
  return NextResponse.redirect(new URL("/login?error=link", origin));
}
