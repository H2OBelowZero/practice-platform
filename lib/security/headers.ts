/**
 * Response headers set from next.config.ts (static; the per-request nonce CSP is set in middleware.ts).
 * Kept pure so tests/unit/security-headers.test.ts can assert every header and every authenticated route prefix.
 */
export interface HeaderRule { source: string; headers: { key: string; value: string }[] }

/** Every authenticated, clinical or token-bearing route: never stored by a browser or shared cache (R35). */
export const noStoreSources = [
  "/app/:path*", "/portal/:path*", "/api/:path*", "/login", "/mfa", "/recover/:path*", "/auth/:path*", "/book/confirmed",
];

export const baseHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }, // no preload: it is hard to undo
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Not "same-origin": that sends no Referer and a null Origin on the cross-origin PayFast checkout POST. This sends only our origin cross-origin (never a path or query), and nothing on a downgrade.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Telehealth (camera/microphone) is Phase 2: relax then, for the video page only.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "X-Frame-Options", value: "DENY" }, // legacy twin of CSP frame-ancestors 'none'
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

export const noStoreHeaders = [
  { key: "Cache-Control", value: "no-store, max-age=0" },
  { key: "Pragma", value: "no-cache" },
];

export function securityHeaders(): HeaderRule[] {
  return [
    { source: "/:path*", headers: baseHeaders },
    ...noStoreSources.map((source) => ({ source, headers: noStoreHeaders })),
  ];
}
