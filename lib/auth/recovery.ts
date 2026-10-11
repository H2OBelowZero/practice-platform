/** A recovery session is only good for changing the password for this long after the emailed link was used. */
export const RECOVERY_WINDOW_SEC = 15 * 60;
const SKEW_SEC = 60; // tolerate small clock differences between the Auth server and this one

/**
 * True when the verified JWT `amr` claim shows a 'recovery' sign-in within the last 15 minutes.
 * Pass the amr from getClaims() (signature-verified), never from an unverified cookie.
 * Accepts `unknown` because the claim is external data: anything that is not an array of
 * { method: string; timestamp: number } (e.g. the string[] form, which has no timestamps) is not fresh.
 */
export function isRecoveryFresh(amr: unknown, nowSec: number): boolean {
  if (!Array.isArray(amr)) return false;
  return amr.some((e) => {
    if (typeof e !== "object" || e === null) return false;
    const { method, timestamp } = e as { method?: unknown; timestamp?: unknown };
    return method === "recovery" && typeof timestamp === "number" && Number.isFinite(timestamp)
      && timestamp <= nowSec + SKEW_SEC && nowSec - timestamp <= RECOVERY_WINDOW_SEC;
  });
}
