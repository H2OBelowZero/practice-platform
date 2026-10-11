import { it, expect } from "vitest";
import { homeFor, isStaffRole, needsMfa } from "@/lib/auth/roles";

it("routes roles to the right area", () => {
  expect(homeFor("psychologist")).toBe("/app"); expect(homeFor("admin")).toBe("/app");
  expect(homeFor("bookkeeper")).toBe("/app"); expect(homeFor("associate")).toBe("/app");
  expect(homeFor("patient")).toBe("/portal"); expect(homeFor("guardian")).toBe("/portal");
});
it("staff need MFA, patients and guardians do not", () => {
  expect(needsMfa("bookkeeper")).toBe(true); expect(needsMfa("psychologist")).toBe(true);
  expect(needsMfa("patient")).toBe(false); expect(needsMfa("guardian")).toBe(false);
  expect(isStaffRole("associate")).toBe(true); expect(isStaffRole("guardian")).toBe(false);
});
