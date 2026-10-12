/**
 * Content-Security-Policy builder. Pure: middleware.ts calls it once per request with a fresh nonce.
 *
 * script-src uses a per-request nonce + 'strict-dynamic' (Next adds the nonce to its own inline and chunk scripts when
 * the request carries the CSP header, which is why every page renders dynamically; see app/layout.tsx). No 'unsafe-inline'
 * for scripts. 'unsafe-eval' is development only (React's dev tooling needs it).
 *
 * style-src keeps 'unsafe-inline': Next injects <style> blocks and React emits style="" attributes (Tailwind v4 output is a
 * linked stylesheet, but Next's own streaming/hydration markup and the Radix popovers use inline styles). Inline styles cannot
 * execute script, so this is the accepted residual. Revisit with style nonces if the UI stops needing style attributes.
 *
 * form-action: PayFast checkout is a real <form method="post"> to https://(www|sandbox).payfast.co.za/eng/process. Chrome also
 * enforces form-action on redirects that follow the POST, so any host PayFast bounces the browser through must be listed here.
 * Today PayFast redirects within its own two hosts, which are the only two allowed. The payer's return to our site is a fresh
 * navigation from PayFast's page (not part of our form's redirect chain) and 'self' covers it anyway. UNVERIFIED until a
 * sandbox payment is run on staging (see README go-live list); if the POST is blocked the console says "violates form-action".
 */

export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** NEXT_PUBLIC_SUPABASE_URL. Used to allow exactly that host (and its realtime websocket) in connect-src. */
  supabaseUrl?: string;
}

/** 128 random bits, base64. Edge-runtime safe (Web Crypto + btoa, no Buffer). */
export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** Exact http(s) and ws(s) origins for the Supabase project, or the *.supabase.co wildcard when the URL is missing or unparseable. */
export function supabaseConnectSources(supabaseUrl?: string): string[] {
  try {
    const u = new URL(supabaseUrl ?? "");
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("protocol");
    return [u.origin, `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`];
  } catch {
    return ["https://*.supabase.co", "wss://*.supabase.co"];
  }
}

export function buildCsp({ nonce, isDev, supabaseUrl }: CspOptions): string {
  // The nonce lands in a header value: refuse anything that is not plain base64/base64url (no `;`, quotes or whitespace).
  if (!/^[A-Za-z0-9+/_-]{16,}={0,2}$/.test(nonce)) throw new Error("buildCsp: invalid nonce");
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${["'self'", ...supabaseConnectSources(supabaseUrl)].join(" ")}`,
    "form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ];
  if (!isDev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
