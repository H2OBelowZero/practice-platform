import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, makeNonce } from "@/lib/security/csp";

const PROTECTED = ["/app", "/portal"];
const isProtected = (p: string) => PROTECTED.some((x) => p === x || p.startsWith(x + "/"));

/** (The PayFast webhook /api/payfast/* and the cron route /api/cron/* are excluded in the matcher below: no session, no Auth round trip.)
 *  Refreshes the Supabase session cookie and sends anonymous visitors from /app and /portal to /login.
 *  Role and MFA checks happen in the pages via requireRole/requireUser (the real gate); this is a cheap first filter. */
export async function middleware(request: NextRequest) {
  // Per-request CSP nonce (Next's documented pattern): Next reads the CSP from the REQUEST headers and stamps the nonce on its own scripts.
  // Fail closed: if the policy cannot be built (NEXT_PUBLIC_SUPABASE_URL missing or invalid in production) nothing is served without a CSP.
  const nonce = makeNonce();
  let csp: string;
  try {
    csp = buildCsp({ nonce, isDev: process.env.NODE_ENV === "development", supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL });
  } catch (e) {
    console.error("middleware: cannot build the Content-Security-Policy:", e instanceof Error ? e.message : "unknown");
    return new NextResponse("Service temporarily unavailable.", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  }
  // Headers handed to Server Components. Rebuilt after a session refresh so they carry the refreshed Cookie header (Supabase's SSR pattern).
  // x-pathname (headers() in requireUser), x-nonce and the CSP are always overwritten here, so a client cannot spoof them.
  const forwardedHeaders = () => {
    const h = new Headers(request.headers);
    h.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);
    h.set("x-nonce", nonce);
    h.set("Content-Security-Policy", csp);
    return h;
  };
  let response = NextResponse.next({ request: { headers: forwardedHeaders() } });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list, headers) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value)); // updates request.headers' cookie, which forwardedHeaders() copies
        response = NextResponse.next({ request: { headers: forwardedHeaders() } });
        list.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v)); // no-store: never cache a response carrying session cookies
      },
    },
  });
  const { data: { user } } = await supabase.auth.getUser(); // verified with the Auth server; also refreshes the cookie
  const { pathname, search } = request.nextUrl;
  if (!user && isProtected(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    url.searchParams.set("next", pathname + search);
    const redirect = NextResponse.redirect(url);
    response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
    for (const k of ["cache-control", "expires", "pragma"]) { const v = response.headers.get(k); if (v) redirect.headers.set(k, v); } // session-cookie responses stay uncacheable
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!api/payfast/|api/cron/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
