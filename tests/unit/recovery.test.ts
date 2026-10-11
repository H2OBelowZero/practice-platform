import { it, expect } from "vitest";
import { isRecoveryFresh } from "@/lib/auth/recovery";

const NOW = 1_800_000_000;
it("accepts a recovery login within 15 minutes", () => {
  expect(isRecoveryFresh([{ method: "recovery", timestamp: NOW - 10 }], NOW)).toBe(true);
  expect(isRecoveryFresh([{ method: "password", timestamp: NOW - 5000 }, { method: "recovery", timestamp: NOW - 899 }], NOW)).toBe(true);
  expect(isRecoveryFresh([{ method: "recovery", timestamp: NOW - 900 }], NOW)).toBe(true); // boundary
});
it("rejects a stale recovery login", () => {
  expect(isRecoveryFresh([{ method: "recovery", timestamp: NOW - 901 }], NOW)).toBe(false);
  expect(isRecoveryFresh([{ method: "recovery", timestamp: NOW - 86_400 }], NOW)).toBe(false);
});
it("rejects sessions that did not come from recovery", () => {
  expect(isRecoveryFresh([{ method: "password", timestamp: NOW - 5 }], NOW)).toBe(false);
  expect(isRecoveryFresh([{ method: "otp", timestamp: NOW - 5 }, { method: "totp", timestamp: NOW - 5 }], NOW)).toBe(false);
  expect(isRecoveryFresh([], NOW)).toBe(false);
});
it("rejects malformed input and timestamps from the future", () => {
  for (const bad of [undefined, null, "recovery", 5, {}, ["recovery"], [null], [{}], [{ method: "recovery" }],
    [{ method: "recovery", timestamp: "now" }], [{ method: "recovery", timestamp: NaN }], [{ method: "recovery", timestamp: Infinity }],
    [{ method: "recovery", timestamp: NOW + 3600 }]]) {
    expect(isRecoveryFresh(bad as never, NOW), JSON.stringify(bad)).toBe(false);
  }
});
