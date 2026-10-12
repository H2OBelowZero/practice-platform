import { describe, it, expect } from "vitest";
import { portionBalances } from "@/lib/billing/portions";
import { isOverdue, parseOverdueFilter, parsePayerFilter, parseStatusFilter } from "@/lib/billing/list";
import { billingNotice } from "@/lib/billing/notices";
import { billingLink } from "@/lib/billing/followups";

describe("portionBalances", () => {
  const P = (method: string, amountCents: number) => ({ method, amountCents });
  it("nothing paid: each side owes its portion", () => {
    expect(portionBalances({ schemeCents: 80000, patientCents: 20000, creditCents: 0, payments: [] })).toEqual({ schemePaidCents: 0, patientPaidCents: 0, schemeOutstandingCents: 80000, patientOutstandingCents: 20000 });
  });
  it("remittances reduce the scheme side, every other method the patient side", () => {
    const b = portionBalances({ schemeCents: 80000, patientCents: 20000, creditCents: 0, payments: [P("medical_aid", 50000), P("eft", 5000), P("payfast", 5000), P("cash", 1000), P("card_machine", 1000)] });
    expect(b).toEqual({ schemePaidCents: 50000, patientPaidCents: 12000, schemeOutstandingCents: 30000, patientOutstandingCents: 8000 });
  });
  it("credit reduces the patient's side first, then the scheme's; never below zero", () => {
    expect(portionBalances({ schemeCents: 80000, patientCents: 20000, creditCents: 5000, payments: [] })).toMatchObject({ patientOutstandingCents: 15000, schemeOutstandingCents: 80000 });
    expect(portionBalances({ schemeCents: 80000, patientCents: 20000, creditCents: 25000, payments: [] })).toMatchObject({ patientOutstandingCents: 0, schemeOutstandingCents: 75000 });
    expect(portionBalances({ schemeCents: 80000, patientCents: 20000, creditCents: 100000, payments: [] })).toMatchObject({ patientOutstandingCents: 0, schemeOutstandingCents: 0 });
  });
  it("a fully paid self-pay invoice owes nothing, and the sides sum to the invoice's outstanding when nothing overlaps", () => {
    const b = portionBalances({ schemeCents: 0, patientCents: 95000, creditCents: 0, payments: [P("eft", 95000)] });
    expect(b.patientOutstandingCents + b.schemeOutstandingCents).toBe(0);
  });
});

describe("billing list filters", () => {
  it("only known statuses and payers pass; anything else is 'any'", () => {
    expect(parseStatusFilter("part_paid")).toBe("part_paid");
    expect(parseStatusFilter("overdue")).toBe("");
    expect(parseStatusFilter("x' or 1=1")).toBe("");
    expect(parseStatusFilter(undefined)).toBe("");
    expect(parsePayerFilter("split")).toBe("split");
    expect(parsePayerFilter("payfast")).toBe("");
    expect(parseOverdueFilter("1")).toBe(true);
    expect(parseOverdueFilter("true")).toBe(false);
  });
  it("overdue = due before today and still open; due today is not overdue", () => {
    expect(isOverdue({ status: "issued", due_date: "2030-01-31" }, "2030-02-01")).toBe(true);
    expect(isOverdue({ status: "part_paid", due_date: "2030-01-31" }, "2030-02-01")).toBe(true);
    expect(isOverdue({ status: "issued", due_date: "2030-02-01" }, "2030-02-01")).toBe(false);
    for (const status of ["draft", "paid", "void"]) expect(isOverdue({ status, due_date: "2020-01-01" }, "2030-02-01")).toBe(false);
  });
});

it("notices: only known codes render", () => {
  expect(billingNotice("issued")).toMatch(/issued/);
  expect(billingNotice("<script>")).toBeUndefined();
  expect(billingNotice("constructor")).toBeUndefined();
  expect(billingNotice(undefined)).toBeUndefined();
});

it("the email link goes to the portal payments page, or via registration when there is no portal account", () => {
  expect(billingLink("https://app.example.com", true)).toBe("https://app.example.com/portal/payments");
  expect(billingLink("https://app.example.com", false)).toBe("https://app.example.com/register?next=/portal/payments");
});
