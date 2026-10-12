import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { paymentRef } from "@/lib/billing/list";

const root = join(__dirname, "..", "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? (f === "node_modules" || f === ".next" ? [] : walk(p)) : [p];
});

describe("paymentRef: a scheme remittance never shows the claim id appended to it (0020)", () => {
  const id = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d";
  it("shows only the advice number of a medical aid payment", () => {
    expect(paymentRef({ method: "medical_aid", reference: null, gateway_ref: `RA-9#${id}` })).toBe("RA-9");
    expect(paymentRef({ method: "medical_aid", reference: null, gateway_ref: "OLD-1" })).toBe("OLD-1"); // a row from before 0020 has no #
  });
  it("leaves manual and PayFast references as they are", () => {
    expect(paymentRef({ method: "eft", reference: "BANK 1", gateway_ref: null })).toBe("BANK 1");
    expect(paymentRef({ method: "payfast", reference: null, gateway_ref: "PF-123" })).toBe("PF-123");
    expect(paymentRef({ method: "cash", reference: null, gateway_ref: null })).toBeNull();
  });
  it("no page or library reads payments.gateway_ref for display except through paymentRef (grep over app/, lib/, components/)", () => {
    const hits: string[] = [];
    for (const f of [...walk(join(root, "app")), ...walk(join(root, "lib")), ...walk(join(root, "components"))].filter((p) => /\.tsx?$/.test(p))) {
      const r = relative(root, f).split(sep).join("/");
      if (r.startsWith("lib/payments/") || r === "lib/billing/list.ts") continue; // the PayFast code owns its own refs; list.ts is the one place that strips the claim id
      const src = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/^\s*\/\/.*$/, "")).join("\n");
      for (const m of src.matchAll(/\.gateway_ref\b/g)) hits.push(`${r}:${src.slice(0, m.index).split("\n").length}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("the claims pages do not load the whole ICD-10 list", () => {
  it("pages read icd10_codes only for the codes of the claim (the picker searches on the server)", () => {
    for (const rel of ["app/app/claims/new/page.tsx", "app/app/claims/[claimId]/page.tsx", "app/app/claims/page.tsx"]) {
      const src = readFileSync(join(root, ...rel.split("/")), "utf8");
      for (const m of src.matchAll(/from\("icd10_codes"\)[^;]*/g)) expect(m[0], rel).toMatch(/\.in\("code"/);
    }
  });
});
