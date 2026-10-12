import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BILLING_ERROR, billingErrorCode, billingErrorText, type BillingErrorCode } from "@/lib/billing/errors";

describe("billing database errors in plain language", () => {
  const CASES: [string, BillingErrorCode][] = [
    ['duplicate key value violates unique constraint "invoices_one_live_per_appointment"', "appointment_has_invoice"],
    ["appointment_not_billable", "appointment_not_billable"], ["appointment_patient_mismatch", "appointment_patient_mismatch"], ["unknown_appointment", "unknown_appointment"],
    ["task_not_open", "task_not_open"], ["zero_total", "zero_total"], ["portions_mismatch", "portions_mismatch"], ["self_pay_has_scheme_portion", "self_pay_has_scheme_portion"],
    ["totals_mismatch", "totals_mismatch"], ["lines_mismatch", "lines_mismatch"], ["lines_required", "lines_required"], ["invalid_line", "invalid_line"], ["invoice_not_draft", "invoice_not_draft"],
    ["invoice_frozen", "invoice_frozen"], ["invoice_lines_frozen", "invoice_lines_frozen"], ["invoice_void_is_final", "invoice_void_is_final"],
    ["invalid_invoice_transition", "invalid_invoice_transition"], ["invoice_has_payments", "invoice_has_payments"], ["invoice_has_open_claims", "invoice_has_open_claims"],
    ["invoice_not_payable", "invoice_not_payable"], ["invoice_not_creditable", "invoice_not_creditable"], ["overpay", "overpay"],
    ["credit_exceeds_outstanding", "credit_exceeds_outstanding"], ["ref_required", "ref_required"], ["future_date", "future_date"], ["invalid_method", "invalid_method"],
    ["invalid_amount", "invalid_amount"], ["reason_required", "reason_required"], ["possible_duplicate", "possible_duplicate"], ["unknown_invoice", "unknown_invoice"],
    ["forbidden", "forbidden"], ['new row violates row-level security policy for table "credit_notes"', "forbidden"], ["permission denied for function record_payment", "forbidden"],
  ];
  it.each(CASES)("%s -> %s", (message, code) => {
    expect(billingErrorCode(message)).toBe(code);
    expect(billingErrorText(message)).toBe(BILLING_ERROR[code]);
  });

  it("unknown, empty and missing messages become the generic text and never echo the raw message", () => {
    for (const m of ["connection reset by peer", "", undefined, null, "SELECT secret FROM x"]) {
      expect(billingErrorCode(m)).toBe("generic");
      expect(billingErrorText(m)).toBe(BILLING_ERROR.generic);
      expect(billingErrorText(m)).not.toContain("secret");
    }
  });

  it("the matching works inside a longer database message", () => {
    expect(billingErrorCode("ERROR:  overpay\nCONTEXT:  PL/pgSQL function payments_guard()")).toBe("overpay");
  });

  it("every user-facing text is a plain sentence: no snake_case codes leak", () => {
    for (const [k, v] of Object.entries(BILLING_ERROR)) { expect(v, k).not.toMatch(/[a-z]+_[a-z]+/); expect(v.length, k).toBeGreaterThan(10); }
  });

  it("every exception the billing SQL can raise is mapped (so none shows as 'something went wrong' by accident)", () => {
    const dir = join(__dirname, "..", "..", "supabase", "migrations");
    const sql = ["0005_billing.sql", "0015_invoice_per_appointment.sql", "0016_billing_fixes.sql"].map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    const raised = [...new Set([...sql.matchAll(/raise exception '([a-z_0-9]+)'/g)].map((m) => m[1]))];
    // codes the billing UI never triggers from a staff session (claims, remittance, ledger internals) are listed here on purpose
    const NOT_FROM_THESE_SCREENS = new Set([
      "invoice_must_start_as_draft", "claim_must_start_as_draft", "claim_link_frozen", "claim_amount_frozen", "claim_frozen", "invalid_claim_transition", "invalid_claim",
      "invoice_not_claimable", "unknown_member", "member_patient_mismatch", "claim_exceeds_scheme_portion", "claims_exceed_scheme_portion", "unknown_icd10",
      "rejection_reason_required", "member_in_use", "unknown_claim", "claim_not_payable", "remittance_exceeds_claim", "ref_conflict", "duplicate_ref",
    ]);
    const unmapped = raised.filter((c) => !NOT_FROM_THESE_SCREENS.has(c) && billingErrorCode(c) === "generic");
    expect(unmapped).toEqual([]);
  });
});
