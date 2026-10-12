import { describe, it, expect } from "vitest";
import { isOverdue, parseOverdueFilter, parsePayerFilter, parseStatusFilter } from "@/lib/billing/list";
import { billingNotice } from "@/lib/billing/notices";
import { billingLink } from "@/lib/billing/followups";

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

import { invoiceAuditFilter, invoiceEventText } from "@/lib/billing/list";
it("invoice history wording and filter", () => {
  expect(invoiceEventText("payment.record")).toBe("Payment recorded");
  expect(invoiceEventText("something.new_thing")).toBe("Something new thing");
  expect(invoiceAuditFilter("11111111-2222-4333-8444-555555555555")).toBe(
    "and(entity.eq.invoices,entity_id.eq.11111111-2222-4333-8444-555555555555),and(entity.in.(payments,credit_notes),detail->>invoice_id.eq.11111111-2222-4333-8444-555555555555)");
});
