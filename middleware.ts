import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, makeNonce } from "@/lib/security/csp";

const PROTECTED = ["/app", "/portal"];
const isProtected = (p: string) => PROTECTED.some((x) => p === x || p.startsWith(x + "/"));

/** (The PayFast webhook /api/payfast/* and the cron route /api/cron/* are excluded in the matcher below: no session, no Auth round trip.)
 *  Refreshes the Supabase session cookie and sends anonymous visitors from /app and /portal to /login.
 *  Role and MFA checks happen in the pages via requireRole/requireUser (the real gate); this is a cheap first filter. */
export async function middleware(request: NextRequest) {
  // Pass the current path to Server Components (headers() in requireUser). Always overwritten here, so a client cannot spoof it.
  const forwarded = new Headers(request.headers);
  forwarded.set("x-pathname", request.nextUrl.pathname + request.nextUrl.search);
  // Per-request CSP nonce (Next's documented pattern): Next reads the CSP from the REQUEST headers and stamps the nonce on its own scripts.
  // Both are always overwritten, so a client cannot supply its own nonce or policy.
  const nonce = makeNonce();
  const csp = buildCsp({ nonce, isDev: process.env.NODE_ENV === "development", supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL });
  forwarded.set("x-nonce", nonce);
  forwarded.set("Content-Security-Policy", csp);
  let response = NextResponse.next({ request: { headers: forwarded } });
  const supabase = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list, headers) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request: { headers: forwarded } });
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
    redirect.headers.set("Content-Security-Policy", csp);
    return redirect;
  }
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: ["/((?!api/payfast/|api/cron/|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
