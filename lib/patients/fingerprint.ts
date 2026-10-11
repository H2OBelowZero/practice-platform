import { createHash } from "node:crypto";

/**
 * A short fingerprint of the set of possible duplicates that was shown to the user (the order of the ids does not matter).
 * It travels in a hidden field with "Create anyway": the confirmation only counts when a fresh duplicate check gives the same
 * fingerprint, so a tick given for one set of matches cannot carry over to a different set. Server-side only (uses node:crypto).
 */
export function duplicateFingerprint(matches: { id: string }[]): string {
  const ids = [...new Set(matches.map((m) => m.id))].sort();
  return createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 32);
}

/** True when "Create anyway" was ticked AND the fingerprint sent back equals the fingerprint of the matches found now. */
export function duplicateConfirmed(ticked: boolean, sent: string | undefined, matches: { id: string }[]): boolean {
  return ticked && matches.length > 0 && sent === duplicateFingerprint(matches);
}
