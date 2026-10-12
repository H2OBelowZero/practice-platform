import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadOutstanding, outstandingCents } from "@/lib/billing/outstanding";

describe("outstandingCents", () => {
  it.each([
    [{ totalCents: 100000, creditCents: 0, paidCents: 0 }, 100000],
    [{ totalCents: 100000, creditCents: 10000, paidCents: 30000 }, 60000],
    [{ totalCents: 100000, creditCents: 0, paidCents: 100000 }, 0],
    [{ totalCents: 100000, creditCents: 50000, paidCents: 60000 }, 0], // never negative
    [{ totalCents: 0, creditCents: 0, paidCents: 0 }, 0],
  ])("%j -> %i", (o, v) => expect(outstandingCents(o)).toBe(v));
});

/** minimal fake of the three calls loadOutstanding makes */
function fake(o: { invoice?: unknown; credits?: unknown[]; paid?: unknown; err?: "invoice" | "credits" | "paid" }) {
  const e = { code: "XX", message: "boom" };
  const calls: string[] = [];
  const client = {
    from(t: string) {
      calls.push("from:" + t);
      return {
        select: () => ({
          eq: (col: string, id: string) => {
            calls.push(`${t}.${col}=${id}`);
            if (t === "invoices") return { maybeSingle: async () => (o.err === "invoice" ? { data: null, error: e } : { data: o.invoice ?? null, error: null }) };
            return Promise.resolve(o.err === "credits" ? { data: null, error: e } : { data: o.credits ?? [], error: null });
          },
        }),
      };
    },
    async rpc(fn: string, args: unknown) {
      calls.push(`rpc:${fn}:${JSON.stringify(args)}`);
      return o.err === "paid" ? { data: null, error: e } : { data: o.paid ?? 0, error: null };
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

describe("loadOutstanding", () => {
  it("combines total, credit notes and the invoice_paid_cents RPC", async () => {
    const { client, calls } = fake({ invoice: { id: "i1", status: "part_paid", total_cents: 100000 }, credits: [{ amount_cents: 10000 }, { amount_cents: 5000 }], paid: 25000 });
    expect(await loadOutstanding(client, "i1")).toEqual({ invoiceId: "i1", status: "part_paid", totalCents: 100000, creditCents: 15000, paidCents: 25000, outstandingCents: 60000 });
    expect(calls).toContain('rpc:invoice_paid_cents:{"p_invoice":"i1"}');
  });
  it("is never negative", async () => {
    const { client } = fake({ invoice: { id: "i1", status: "paid", total_cents: 100 }, paid: 500 });
    expect((await loadOutstanding(client, "i1"))?.outstandingCents).toBe(0);
  });
  it("returns null for an unknown invoice", async () => expect(await loadOutstanding(fake({}).client, "nope")).toBeNull());
  it.each(["invoice", "credits", "paid"] as const)("throws on a %s read error rather than guessing a balance", async (err) => {
    await expect(loadOutstanding(fake({ invoice: { id: "i", status: "issued", total_cents: 1 }, err }).client, "i")).rejects.toThrow(/boom/);
  });
});
