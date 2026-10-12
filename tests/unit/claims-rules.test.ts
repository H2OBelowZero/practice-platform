import { describe, it, expect } from "vitest";
import { parseApproved, parseClaimForm, parseClaimRef, parseMemberForm, parseRejection, parseRemittance } from "@/lib/claims/input";
import { claimErrorCode, claimErrorText, CLAIM_ERROR } from "@/lib/claims/errors";
import { filterIcd10, parseIcd10List } from "@/lib/claims/icd10";
import { ACTION_FROM, ACTION_TO, CLAIM_STATUSES, claimableCents, claimActions, daysSince, isCurrentMember, isStale, memberState, staleBefore, submitReadiness, unpaidCents } from "@/lib/claims/rules";
import { claimEventDetail, claimEventText, claimNotice, CLAIM_STATUS_FILTERS, parseClaimStatusFilter } from "@/lib/claims/view";
import { statusMeta } from "@/lib/status";

const M = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d";
const member = { scheme: "Discovery", member_number: "12345678" };

describe("member form (Zod)", () => {
  it("accepts a normal member and turns blanks into undefined", () => {
    const r = parseMemberForm({ ...member, plan: "", dependant_code: "01", main_member_name: " ", valid_from: "2026-01-01", valid_to: "" });
    expect(r).toEqual({ ok: true, value: { scheme: "Discovery", member_number: "12345678", dependant_code: "01", valid_from: "2026-01-01", memberId: undefined, plan: undefined, main_member_name: undefined, valid_to: undefined } });
  });
  it("member number: 3 to 30 characters, letters, digits, hyphen and space only", () => {
    for (const ok of ["123", "AB-123 456", "a1b", "9".repeat(30)]) expect(parseMemberForm({ ...member, member_number: ok }).ok, ok).toBe(true);
    for (const bad of ["12", "", "  ", "9".repeat(31), "12#45", "12.45", "<b>123", "12\n34", "-123", "123-"]) {
      const r = parseMemberForm({ ...member, member_number: bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(r.field).toBe("member_number");
    }
  });
  it("the scheme is required; the dependant code is short and alphanumeric", () => {
    expect(parseMemberForm({ member_number: "123" })).toMatchObject({ ok: false, field: "scheme" });
    expect(parseMemberForm({ ...member, scheme: "x".repeat(81) })).toMatchObject({ ok: false, field: "scheme" });
    expect(parseMemberForm({ ...member, dependant_code: "01-" })).toMatchObject({ ok: false, field: "dependant_code" });
  });
  it("dates must be real and the end cannot be before the start", () => {
    expect(parseMemberForm({ ...member, valid_from: "2026-02-30" })).toMatchObject({ ok: false, field: "valid_from" });
    expect(parseMemberForm({ ...member, valid_to: "not a date" })).toMatchObject({ ok: false, field: "valid_to" });
    expect(parseMemberForm({ ...member, valid_from: "2026-05-02", valid_to: "2026-05-01" })).toMatchObject({ ok: false, field: "valid_to" });
    expect(parseMemberForm({ ...member, valid_from: "2026-05-01", valid_to: "2026-05-01" }).ok).toBe(true);
  });
  it("a memberId, when present, must be a uuid", () => {
    expect(parseMemberForm({ ...member, memberId: "nope" }).ok).toBe(false);
    expect(parseMemberForm({ ...member, memberId: M }).ok).toBe(true);
  });
});

describe("claim form (Zod)", () => {
  const ok = { memberId: M, amount: "600,00", tariff: "86205", preauth: "", icd10: "F41.1,f32.9" };
  it("parses amount to cents, upper-cases and de-duplicates codes", () => {
    expect(parseClaimForm({ ...ok, icd10: "F41.1,f41.1, F32.9 " })).toEqual({ ok: true, value: { memberId: M, amount: 60000, tariff: "86205", preauth: undefined, icd10: ["F41.1", "F32.9"] } });
    expect(parseClaimForm({ ...ok, icd10: "" })).toMatchObject({ ok: true, value: { icd10: [] } });
    expect(parseClaimForm({ memberId: M, amount: "1 234,50", tariff: "A1" })).toMatchObject({ ok: true, value: { amount: 123450, icd10: [] } });
  });
  it("rejects amounts that are not clean rand figures", () => {
    for (const bad of ["", "0", "0,00", "-5", "abc", "1,234.50", "1e3", "12,345"]) expect(parseClaimForm({ ...ok, amount: bad }), bad).toMatchObject({ ok: false, field: "amount" });
  });
  it("tariff code is 1 to 20 letters or digits", () => {
    for (const bad of ["", "86-205", "x".repeat(21), "86 205", "<b>"]) expect(parseClaimForm({ ...ok, tariff: bad }), bad).toMatchObject({ ok: false, field: "tariff" });
    expect(parseClaimForm({ ...ok, tariff: "x".repeat(20) }).ok).toBe(true);
  });
  it("pre-authorisation is optional but constrained", () => {
    expect(parseClaimForm({ ...ok, preauth: "PA-2026/001" }).ok).toBe(true);
    expect(parseClaimForm({ ...ok, preauth: "<script>" })).toMatchObject({ ok: false, field: "preauth" });
  });
  it("diagnosis codes must be shaped like codes and there are at most 12", () => {
    expect(parseClaimForm({ ...ok, icd10: "F41.1,hello" })).toMatchObject({ ok: false, field: "icd10" });
    expect(parseClaimForm({ ...ok, icd10: "F41.1;DROP" })).toMatchObject({ ok: false, field: "icd10" });
    const many = Array.from({ length: 13 }, (_, i) => `F${10 + i}`).join(",");
    expect(parseClaimForm({ ...ok, icd10: many })).toMatchObject({ ok: false, field: "icd10" });
  });
  it("the member must be chosen", () => {
    expect(parseClaimForm({ ...ok, memberId: "" })).toMatchObject({ ok: false, field: "memberId" });
    expect(parseClaimForm({ ...ok, memberId: "../x" })).toMatchObject({ ok: false, field: "memberId" });
  });
});

describe("action forms", () => {
  it("claim reference is optional", () => {
    expect(parseClaimRef({})).toEqual({ ok: true, value: { claimRef: undefined } });
    expect(parseClaimRef({ claim_ref: " CR-1 " })).toEqual({ ok: true, value: { claimRef: "CR-1" } });
    expect(parseClaimRef({ claim_ref: "a;b" }).ok).toBe(false);
  });
  it("approved amount must be a positive rand figure", () => {
    expect(parseApproved({ approved: "550" })).toEqual({ ok: true, value: { approvedCents: 55000 } });
    expect(parseApproved({ approved: "0" })).toMatchObject({ ok: false, field: "approved" });
    expect(parseApproved({})).toMatchObject({ ok: false, field: "approved" });
  });
  it("a rejection needs a reason of 1 to 300 characters", () => {
    expect(parseRejection({ reason: "  Wrong tariff  " })).toEqual({ ok: true, value: { reason: "Wrong tariff" } });
    expect(parseRejection({ reason: "   " })).toMatchObject({ ok: false, field: "reason" });
    expect(parseRejection({})).toMatchObject({ ok: false, field: "reason" });
    expect(parseRejection({ reason: "x".repeat(300) }).ok).toBe(true);
    expect(parseRejection({ reason: "x".repeat(301) })).toMatchObject({ ok: false, field: "reason" });
  });
  it("a scheme payment needs an amount and a reference", () => {
    expect(parseRemittance({ amount: "300,00", ref: " RA-77 " })).toEqual({ ok: true, value: { amountCents: 30000, ref: "RA-77" } });
    expect(parseRemittance({ amount: "300", ref: "" })).toMatchObject({ ok: false, field: "ref" });
    expect(parseRemittance({ amount: "300" })).toMatchObject({ ok: false, field: "ref" });
    expect(parseRemittance({ amount: "0", ref: "R" })).toMatchObject({ ok: false, field: "amount" });
    expect(parseRemittance({ amount: "3", ref: "x".repeat(101) })).toMatchObject({ ok: false, field: "ref" });
  });
});

describe("status / action matrix", () => {
  it("offers exactly the moves the database allows", () => {
    expect(claimActions("draft")).toEqual(["edit", "submit"]);
    expect(claimActions("submitted")).toEqual(["accept", "reject", "remit"]);
    expect(claimActions("accepted")).toEqual(["remit"]);
    expect(claimActions("rejected")).toEqual(["resubmit", "reopen"]);
    expect(claimActions("part_paid")).toEqual(["remit"]);
    expect(claimActions("paid")).toEqual([]);
    expect(claimActions("bogus")).toEqual([]);
    expect(CLAIM_STATUSES.every((s) => Array.isArray(claimActions(s)))).toBe(true);
  });
  it("the status-changing actions start and end where claims_guard says (draft->submitted, submitted->accepted|rejected, rejected->submitted|draft)", () => {
    const allowed = new Set(["draft>submitted", "submitted>accepted", "submitted>rejected", "accepted>submitted", "rejected>submitted", "rejected>draft"]);
    for (const a of Object.keys(ACTION_FROM) as (keyof typeof ACTION_FROM)[]) expect(allowed.has(`${ACTION_FROM[a]}>${ACTION_TO[a]}`), a).toBe(true);
  });
  it("part_paid and paid are never an action target (only record_scheme_remittance gets there)", () => {
    expect(Object.values(ACTION_TO)).not.toContain("part_paid");
    expect(Object.values(ACTION_TO)).not.toContain("paid");
  });
  it("every claim status has a chip with an icon and text", () => {
    for (const s of CLAIM_STATUSES) expect(statusMeta(s).label.length).toBeGreaterThan(0);
    expect(CLAIM_STATUS_FILTERS.map((f) => f.value)).toEqual(["", ...CLAIM_STATUSES]);
    expect(parseClaimStatusFilter("rejected")).toBe("rejected");
    expect(parseClaimStatusFilter("'; drop")).toBe("");
  });
});

describe("submit readiness", () => {
  const good = { icdCount: 1, memberCurrent: true, claimedCents: 100, role: "psychologist" };
  it("is ready with a code, a current member and an amount", () => { expect(submitReadiness(good)).toEqual({ ok: true, missing: [] }); });
  it("lists every missing piece in plain language", () => {
    const r = submitReadiness({ icdCount: 0, memberCurrent: false, claimedCents: 0, role: "psychologist" });
    expect(r.ok).toBe(false);
    expect(r.missing).toHaveLength(3);
    expect(r.missing.join(" ")).toMatch(/ICD-10/);
    expect(r.missing.join(" ")).toMatch(/membership is not current/);
    expect(r.missing.join(" ")).toMatch(/more than R 0,00/);
  });
  it("tells the admin that the practitioner adds the diagnosis codes", () => {
    expect(submitReadiness({ ...good, icdCount: 0, role: "admin" }).missing[0]).toMatch(/added by the practitioner/);
  });
  it("each requirement alone blocks submission", () => {
    expect(submitReadiness({ ...good, icdCount: 0 }).ok).toBe(false);
    expect(submitReadiness({ ...good, memberCurrent: false }).ok).toBe(false);
    expect(submitReadiness({ ...good, claimedCents: 0 }).ok).toBe(false);
  });
});

describe("members, amounts, ages", () => {
  it("memberState follows the SAST date", () => {
    expect(memberState({ valid_from: null, valid_to: null }, "2026-10-12")).toBe("current");
    expect(memberState({ valid_from: "2026-10-12", valid_to: "2026-10-12" }, "2026-10-12")).toBe("current");
    expect(memberState({ valid_from: "2026-01-01", valid_to: "2026-10-11" }, "2026-10-12")).toBe("expired");
    expect(memberState({ valid_from: "2026-10-13", valid_to: null }, "2026-10-12")).toBe("upcoming");
    expect(isCurrentMember({ valid_from: "2026-01-01", valid_to: null }, "2026-10-12")).toBe(true);
    expect(["current", "expired", "upcoming"].map((k) => statusMeta(k).label)).toEqual(["Current", "Expired", "Not started"]);
  });
  it("claimableCents is the scheme portion minus claims that are not rejected", () => {
    const cl = [{ id: "a", status: "submitted", claimed_cents: 30000 }, { id: "b", status: "rejected", claimed_cents: 50000 }, { id: "c", status: "draft", claimed_cents: 10000 }];
    expect(claimableCents(80000, cl)).toBe(40000);
    expect(claimableCents(80000, cl, "c")).toBe(50000);
    expect(claimableCents(10000, cl)).toBe(0);
  });
  it("unpaidCents never goes below zero", () => { expect(unpaidCents(80000, 30000)).toBe(50000); expect(unpaidCents(80000, 90000)).toBe(0); });
  it("daysSince counts SAST calendar days; staleness is more than 30 days after submission", () => {
    expect(daysSince("2026-10-12T10:00:00+02:00", "2026-10-12")).toBe(0);
    expect(daysSince("2026-10-11T23:30:00Z", "2026-10-13")).toBe(1); // 01:30 SAST on the 12th
    expect(daysSince(null, "2026-10-12")).toBeNull();
    expect(daysSince("2026-10-20T10:00:00Z", "2026-10-12")).toBe(0);
    expect(isStale({ status: "submitted", submitted_at: "2026-09-12T10:00:00Z" }, "2026-10-12")).toBe(false); // exactly 30 days
    expect(isStale({ status: "submitted", submitted_at: "2026-09-11T10:00:00Z" }, "2026-10-12")).toBe(true);
    expect(isStale({ status: "rejected", submitted_at: "2026-01-01T10:00:00Z" }, "2026-10-12")).toBe(false);
    expect(staleBefore("2026-10-12")).toBe("2026-09-12T00:00:00+02:00");
  });
});

describe("ICD-10 search and parsing", () => {
  const list = [
    { code: "F32.9", description: "Depressive episode, unspecified" }, { code: "F41.1", description: "Generalised anxiety disorder" },
    { code: "F41.9", description: "Anxiety disorder, unspecified" }, { code: "Z63.0", description: "Problems in relationship with spouse or partner" },
  ];
  it("matches by code (with or without the dot, any case) and by words in the description", () => {
    expect(filterIcd10(list, "f41").map((c) => c.code)).toEqual(["F41.1", "F41.9"]);
    expect(filterIcd10(list, "f411").map((c) => c.code)).toEqual(["F41.1"]);
    expect(filterIcd10(list, "ANXIETY").map((c) => c.code)).toEqual(["F41.1", "F41.9"]);
    expect(filterIcd10(list, "anxiety unspecified").map((c) => c.code)).toEqual(["F41.9"]);
    expect(filterIcd10(list, "zzz")).toEqual([]);
  });
  it("an empty search keeps everything and does not mutate the list", () => {
    expect(filterIcd10(list, "   ")).toHaveLength(4);
    expect(filterIcd10(list, "")).not.toBe(list);
  });
  it("parseIcd10List accepts code-shaped entries only", () => {
    expect(parseIcd10List("F41.1, z63.0,F41.1")).toEqual(["F41.1", "Z63.0"]);
    expect(parseIcd10List("")).toEqual([]);
    expect(parseIcd10List(undefined)).toEqual([]);
    expect(parseIcd10List("F41.1,'; drop")).toBeNull();
    expect(parseIcd10List("F4")).toBeNull();
  });
});

describe("database errors in plain language", () => {
  it("maps the codes the claim rules raise", () => {
    const cases: [string, keyof typeof CLAIM_ERROR][] = [
      ["invoice_not_claimable", "invoice_not_claimable"], ["claims_exceed_scheme_portion", "claims_exceed_scheme_portion"], ["claim_exceeds_scheme_portion", "claim_exceeds_scheme_portion"],
      ["unknown_icd10", "unknown_icd10"], ["forbidden", "forbidden"], ["new row violates row-level security policy", "forbidden"], ["permission denied for table claims", "forbidden"],
      ["ref_conflict", "ref_conflict"], ["duplicate_ref", "ref_conflict"], ["remittance_exceeds_claim", "remittance_exceeds_claim"], ["overpay", "overpay"],
      ["invoice_not_payable", "invoice_not_payable"], ["claim_not_payable", "claim_not_payable"], ["ref_required", "ref_required"], ["invalid_claim_transition", "invalid_claim_transition"],
      ["claim_frozen", "claim_frozen"], ["claim_link_frozen", "claim_link_frozen"], ["claim_amount_frozen", "claim_amount_frozen"], ["rejection_reason_required", "rejection_reason_required"],
      ['new row for relation "claims" violates check constraint "claims_check"', "amount_over_claimed"],
    ];
    for (const [msg, code] of cases) expect(claimErrorCode(msg), msg).toBe(code);
  });
  it("anything else is generic and never echoes the message", () => {
    expect(claimErrorCode("syntax error at or near F41.1")).toBe("generic");
    expect(claimErrorText("connection refused to 10.0.0.5")).toBe(CLAIM_ERROR.generic);
    expect(claimErrorText(undefined)).toBe(CLAIM_ERROR.generic);
  });
});

describe("timeline wording", () => {
  it("describes status changes, resubmission and scheme payments", () => {
    expect(claimEventText({ event: "status:draft", from_status: null, to_status: "draft" })).toBe("Draft claim started");
    expect(claimEventText({ event: "status:submitted", from_status: "draft", to_status: "submitted" })).toBe("Marked as submitted");
    expect(claimEventText({ event: "status:submitted", from_status: "rejected", to_status: "submitted" })).toBe("Marked as submitted again");
    expect(claimEventText({ event: "status:draft", from_status: "rejected", to_status: "draft" })).toMatch(/Returned to draft/);
    expect(claimEventText({ event: "status:rejected", from_status: "submitted", to_status: "rejected" })).toBe("Marked as rejected");
    expect(claimEventText({ event: "remittance", from_status: "submitted", to_status: "part_paid" })).toMatch(/part paid/);
    expect(claimEventText({ event: "remittance", from_status: "part_paid", to_status: "paid" })).toMatch(/fully paid/);
  });
  it("leaves out the status change a scheme payment causes (the payment row shows it)", () => {
    expect(claimEventText({ event: "status:part_paid", from_status: "submitted", to_status: "part_paid" })).toBeNull();
    expect(claimEventText({ event: "status:paid", from_status: "part_paid", to_status: "paid" })).toBeNull();
    expect(claimEventText({ event: "something_else", from_status: null, to_status: null })).toBeNull();
  });
  it("shows the amount and reference of a payment and the reason of a rejection, and nothing from other details", () => {
    expect(claimEventDetail({ event: "remittance", from_status: "submitted", to_status: "paid", detail: { amount: 80000, ref: "RA-1" } })).toBe("R 800,00, reference RA-1");
    expect(claimEventDetail({ event: "status:rejected", from_status: "submitted", to_status: "rejected", detail: { reason: "No pre-auth" } })).toBe("Reason: No pre-auth");
    expect(claimEventDetail({ event: "status:submitted", from_status: "draft", to_status: "submitted", detail: { reason: "x" } })).toBeNull();
    expect(claimEventDetail({ event: "status:rejected", from_status: "submitted", to_status: "rejected", detail: null })).toBeNull();
    expect(claimEventDetail({ event: "status:rejected", from_status: "submitted", to_status: "rejected", detail: [1] })).toBeNull();
  });
  it("only known notice codes render", () => {
    expect(claimNotice("remitted")).toMatch(/scheme payment/);
    expect(claimNotice("<b>")).toBeUndefined();
    expect(claimNotice("constructor")).toBeUndefined();
  });
});
