import { describe, it, expect } from "vitest";
import { taskLink } from "@/lib/tasks/links";

const T = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d", P = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", I = "11111111-2222-4333-8444-555555555555", N = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("taskLink", () => {
  it("late_cancel_fee opens the invoice form for that task", () => {
    expect(taskLink({ id: T, source: "late_cancel_fee", patient_id: P })).toEqual({ href: `/app/billing/new?task=${T}`, label: "Create invoice" });
  });
  it("payfast_unreconciled opens the invoice named in meta, else the patient's billing tab", () => {
    expect(taskLink({ id: T, source: "payfast_unreconciled:777", meta: { invoice_id: I }, patient_id: P })).toEqual({ href: `/app/billing/${I}`, label: "Open invoice" });
    expect(taskLink({ id: T, source: "payfast_unreconciled:777", meta: {}, patient_id: P })?.href).toBe(`/app/patients/${P}?tab=billing`);
    expect(taskLink({ id: T, source: "payfast_unreconciled:777", meta: { invoice_id: "../x" } })).toBeNull();
  });
  it("consent_withdrawn, claim_rejected and duplicate_patient lead to the patient", () => {
    expect(taskLink({ id: T, source: "consent_withdrawn", patient_id: P })?.href).toBe(`/app/patients/${P}?tab=forms`);
    expect(taskLink({ id: T, source: "claim_rejected", patient_id: P })?.href).toBe(`/app/patients/${P}?tab=billing`);
    expect(taskLink({ id: T, source: "duplicate_patient", patient_id: P })?.href).toBe(`/app/patients/${P}`);
  });
  it("risk_flag opens the note", () => {
    expect(taskLink({ id: T, source: `risk_flag:${N}`, patient_id: P })).toEqual({ href: `/app/notes/${N}`, label: "Open note" });
    expect(taskLink({ id: T, source: "risk_flag:not-an-id", patient_id: P })?.href).toBe(`/app/patients/${P}?tab=notes`);
  });
  it("unknown or missing sources and bad ids give no link", () => {
    expect(taskLink({ id: T, source: null })).toBeNull();
    expect(taskLink({ id: T, source: "something_new", patient_id: P })).toBeNull();
    expect(taskLink({ id: T, source: "consent_withdrawn", patient_id: null })).toBeNull();
    expect(taskLink({ id: T, source: "duplicate_patient", patient_id: "x/../y" })).toBeNull();
    expect(taskLink({ id: "bad", source: "late_cancel_fee" })).toBeNull();
  });
});
