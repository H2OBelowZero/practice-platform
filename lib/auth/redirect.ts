// Open-redirect guard for `next` parameters: only same-origin relative paths ("/x", "/x?y#z") are accepted.
// Rejects "//host", "/\host", any backslash, whitespace/control characters, absolute URLs, and percent-encoded
// slash/backslash tricks at the start ("/%2F/host"). Anything else falls back.
const START_OF_AUTHORITY = /^\/[/\\]/;
const BAD_CHARS = /[\\\u0000- \u007f]/;

export function safeNext(next: string | undefined | null, fallback: string): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 1024) return fallback;
  if (!next.startsWith("/") || START_OF_AUTHORITY.test(next) || BAD_CHARS.test(next)) return fallback;
  try {
    if (START_OF_AUTHORITY.test(decodeURIComponent(next))) return fallback;
  } catch {
    return fallback;
  }
  return next;
}
