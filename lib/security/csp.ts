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
  /** NEXT_PUBLIC_SUPABASE_URL. Allows exactly that origin (and its realtime websocket) in connect-src. Required in production: buildCsp throws without it. */
  supabaseUrl?: string;
}

/** 128 random bits, base64. Edge-runtime safe (Web Crypto + btoa, no Buffer). */
export function makeNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** What `supabase start` serves; only ever used in development when NEXT_PUBLIC_SUPABASE_URL is not set. */
export const LOCAL_SUPABASE_URL = "http://localhost:54321";

/**
 * Exact http(s) and ws(s) origins of the Supabase project. Fails closed: a missing or unusable URL throws in production
 * (no wildcard fallback: *.supabase.co would let injected script send data to anyone's Supabase project). Development falls back to the local default.
 */
export function supabaseConnectSources(supabaseUrl: string | undefined, isDev: boolean): string[] {
  const raw = supabaseUrl?.trim() || (isDev ? LOCAL_SUPABASE_URL : "");
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("buildCsp: NEXT_PUBLIC_SUPABASE_URL is missing or not a valid URL"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("buildCsp: NEXT_PUBLIC_SUPABASE_URL must be an http(s) URL");
  return [u.origin, `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}`];
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
    `connect-src ${["'self'", ...supabaseConnectSources(supabaseUrl, isDev)].join(" ")}`,
    "form-action 'self' https://www.payfast.co.za https://sandbox.payfast.co.za",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ];
  if (!isDev) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}
