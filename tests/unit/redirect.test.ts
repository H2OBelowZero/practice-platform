import { it, expect } from "vitest";
import { safeNext } from "@/lib/auth/redirect";

it("accepts same-origin relative paths", () => {
  expect(safeNext("/app", "/x")).toBe("/app");
  expect(safeNext("/portal/invoices?id=1#top", "/x")).toBe("/portal/invoices?id=1#top");
  expect(safeNext("/", "/x")).toBe("/");
  expect(safeNext("/book?slot=a%2Fb", "/x")).toBe("/book?slot=a%2Fb");
});
it.each([
  undefined, null, "", "app", "//evil.example", "/\\evil.example", "\\\\evil.example", "/\\/evil.example", "\\evil.example",
  "http://evil.example", "https://evil.example/app", "javascript:alert(1)", "data:text/html,x",
  " //evil.example", "/ /evil.example", "/\t/evil.example", "/\n/evil.example", "/%2F/evil.example", "/%5Cevil.example",
  "/%", "/app\r\nSet-Cookie: x=1", "/" + "a".repeat(3000),
])("rejects %j", (bad) => {
  expect(safeNext(bad as string | undefined, "/fallback")).toBe("/fallback");
});

import { mfaUrl } from "@/lib/auth/redirect";
it("mfaUrl carries only a safe current path", () => {
  expect(mfaUrl("/app/patients?x=1")).toBe("/mfa?next=%2Fapp%2Fpatients%3Fx%3D1");
  for (const bad of [null, undefined, "", "//evil.example", "https://evil.example", "/\\evil.example"]) expect(mfaUrl(bad)).toBe("/mfa");
});
