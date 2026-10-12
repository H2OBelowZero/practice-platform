"use server";

import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { audit } from "@/lib/audit";
import { safely } from "@/lib/appointments/followups";
import type { ActionState, Values } from "@/lib/appointments/types";
import { requireRole } from "@/lib/auth/session";
import { loadOutstanding } from "@/lib/billing/outstanding";
import { CLAIM_ERROR, claimErrorCode, claimErrorText } from "@/lib/claims/errors";
import { icd10Query, parseApproved, parseClaimForm, parseClaimRef, parseMemberForm, parseRejection, parseRemittance, uuid } from "@/lib/claims/input";
import { ICD10_RESULTS_MAX, icd10SearchWords, icd10WordFilter, mapIcd10Rows, type Icd10 } from "@/lib/claims/icd10";
import { ACCEPT_FROM, ACTION_FROM, ACTION_TO, claimableCents, claimBasisCents, isCurrentMember, submitReadiness, unpaidCents, type ClaimStatus } from "@/lib/claims/rules";
import type { PatientNoticeCode } from "@/lib/patients/notices";
import { formatZar } from "@/lib/money";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";

// Staff medical aid actions. Every one calls requireRole itself (R26), validates with Zod, and writes through the signed-in user's own client,
// so RLS and the claim rules in the database (0005 claims_guard, record_scheme_remittance) decide. Success redirects.
// AUDIT: ids and field NAMES only. Never an ICD-10 code, a rejection reason, a member number or a reference in an audit row, a log, a URL or a title.
// Scheme payments are audited by record_scheme_remittance itself (claim.remittance); the app never writes the ledger tables directly.
const STAFF = ["psychologist", "admin"] as const;
const PSY = ["psychologist"] as const;
const generic = { error: CLAIM_ERROR.generic };
const NOT_FOUND = { error: CLAIM_ERROR.unknown_claim };
const STALE = { error: CLAIM_ERROR.invalid_claim_transition };
const done = (id: string, notice: string): never => redirect(`/app/claims/${id}?notice=${notice}`);

type Row = {
  id: string; invoice_id: string; member_id: string; status: string; claimed_cents: number; approved_cents: number | null;
  tariff_code: string | null; preauth_ref: string | null; claim_ref: string | null; icd10_codes: string[] | null;
  invoices: { patient_id: string } | { patient_id: string }[] | null;
};
const CLAIM_COLS = "id, invoice_id, member_id, status, claimed_cents, approved_cents, tariff_code, preauth_ref, claim_ref, icd10_codes, invoices(patient_id)";

async function loadClaim(sb: SupabaseClient, rawId: unknown) {
  const id = uuid.safeParse(rawId);
  if (!id.success) return null;
  const { data } = await sb.from("claims").select(CLAIM_COLS).eq("id", id.data).maybeSingle();
  if (!data) return null;
  const claim = data as unknown as Row;
  const inv = Array.isArray(claim.invoices) ? claim.invoices[0] : claim.invoices;
  return { claim, patientId: inv?.patient_id ?? null };
}
const ids = (c: Row, patientId: string | null) => ({ invoice_id: c.invoice_id, patient_id: patientId });

/** A member of this patient, with its dates; null when it is not theirs. */
async function memberOf(sb: SupabaseClient, memberId: string, patientId: string | null) {
  if (!patientId) return null;
  const { data } = await sb.from("medical_aid_members").select("id, valid_from, valid_to").eq("id", memberId).eq("patient_id", patientId).maybeSingle();
  return (data as { id: string; valid_from: string | null; valid_to: string | null } | null) ?? null;
}

// ---- members --------------------------------------------------------------------------------------------------------------------
const memberBack = (patientId: string, notice: PatientNoticeCode): never => redirect(`/app/patients/${patientId}?tab=medical-aid&notice=${notice}`);
const MEMBER_COLS = ["scheme", "plan", "member_number", "dependant_code", "main_member_name", "valid_from", "valid_to"] as const;

/**
 * Add a medical aid member to a patient, or (when the form carries memberId) change one. A member is never deleted: end-date it instead.
 * The audit row names the member's id and, for a change, the field names that changed: never the member number or any other value.
 */
export async function saveMember(rawPatientId: unknown, values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const patientId = uuid.safeParse(rawPatientId);
  if (!patientId.success) return generic;
  const p = parseMemberForm(values);
  if (!p.ok) return { error: p.error, field: p.field };
  const v = p.value;
  const next = {
    scheme: v.scheme, plan: v.plan ?? null, member_number: v.member_number, dependant_code: v.dependant_code ?? null,
    main_member_name: v.main_member_name ?? null, valid_from: v.valid_from ?? null, valid_to: v.valid_to ?? null,
  };

  const sb = await supabaseServer();
  const { data: pat } = await sb.from("patients").select("id").eq("id", patientId.data).maybeSingle();
  if (!pat) return { error: "We could not find that patient." };

  if (!v.memberId) {
    const { data, error } = await sb.from("medical_aid_members").insert({ patient_id: patientId.data, ...next }).select("id").single();
    if (error || !data) return generic;
    await safely("member.create", () => audit("member.create", "medical_aid_members", data.id as string, { patient_id: patientId.data }));
    return memberBack(patientId.data, "member_added");
  }

  const { data: cur } = await sb.from("medical_aid_members").select(MEMBER_COLS.join(", ")).eq("id", v.memberId).eq("patient_id", patientId.data).maybeSingle();
  if (!cur) return { error: CLAIM_ERROR.unknown_member };
  const before = cur as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const k of MEMBER_COLS) if ((before[k] ?? null) !== next[k]) patch[k] = next[k];
  if (Object.keys(patch).length === 0) return memberBack(patientId.data, "unchanged");
  const { data, error } = await sb.from("medical_aid_members").update(patch).eq("id", v.memberId).eq("patient_id", patientId.data).select("id");
  if (error || !data?.length) return generic;
  await safely("member.update", () => audit("member.update", "medical_aid_members", v.memberId!, { patient_id: patientId.data, fields: Object.keys(patch) }));
  return memberBack(patientId.data, "member_saved");
}

// ---- claims ---------------------------------------------------------------------------------------------------------------------
type Invoice = { id: string; patient_id: string; status: string; payer_type: string; scheme_portion_cents: number };

/** The invoice a claim is about, and the cents of its scheme portion still free to claim; null when the invoice cannot take a claim. */
async function claimableInvoice(sb: SupabaseClient, invoiceId: string, exceptClaim?: string): Promise<{ error: string } | { inv: Invoice; remaining: number }> {
  const { data } = await sb.from("invoices").select("id, patient_id, status, payer_type, scheme_portion_cents").eq("id", invoiceId).maybeSingle();
  const inv = data as Invoice | null;
  if (!inv) return { error: CLAIM_ERROR.unknown_invoice };
  if (!["issued", "part_paid"].includes(inv.status) || !["medical_aid", "split"].includes(inv.payer_type)) return { error: CLAIM_ERROR.invoice_not_claimable };
  const { data: cl, error } = await sb.from("claims").select("id, status, claimed_cents").eq("invoice_id", invoiceId);
  if (error) return { error: CLAIM_ERROR.generic };
  return { inv, remaining: claimableCents(inv.scheme_portion_cents, (cl ?? []) as { id: string; status: string; claimed_cents: number }[], exceptClaim) };
}

/**
 * Open a DRAFT claim on an issued / part paid medical aid or split invoice. Only the psychologist can attach ICD-10 codes (the database refuses the admin);
 * for the admin the claim is created without codes. The amount cannot exceed what is left of the scheme portion (the database checks it again).
 */
export async function openClaim(rawInvoiceId: unknown, values: Values): Promise<ActionState> {
  const me = await requireRole([...STAFF]);
  const invoiceId = uuid.safeParse(rawInvoiceId);
  if (!invoiceId.success) return generic;
  const p = parseClaimForm(values);
  if (!p.ok) return { error: p.error, field: p.field };
  const f = p.value;
  if (me.role !== "psychologist" && f.icd10.length > 0) return { error: "Diagnosis codes are added by the practitioner.", field: "icd10" };

  const sb = await supabaseServer();
  const found = await claimableInvoice(sb, invoiceId.data);
  if ("error" in found) return { error: found.error };
  if (f.amount > found.remaining) return { error: `That is more than the medical aid portion still to claim (${formatZar(found.remaining)}).`, field: "amount" };
  const member = await memberOf(sb, f.memberId, found.inv.patient_id);
  if (!member) return { error: CLAIM_ERROR.member_patient_mismatch, field: "memberId" };
  if (!isCurrentMember(member, sastDate(new Date()))) return { error: "That medical aid membership is not current. Check its dates on the patient's Medical aid tab.", field: "memberId" };

  const row: Record<string, unknown> = { invoice_id: invoiceId.data, member_id: f.memberId, claimed_cents: f.amount, tariff_code: f.tariff, preauth_ref: f.preauth ?? null };
  if (me.role === "psychologist") row.icd10_codes = f.icd10; // the admin's insert never names the column
  const { data, error } = await sb.from("claims").insert(row).select("id").single();
  if (error || !data) return { error: claimErrorText(error?.message), field: error?.message.includes("unknown_icd10") ? "icd10" : undefined };
  await safely("claim.create", () => audit("claim.create", "claims", data.id as string, { invoice_id: invoiceId.data, patient_id: found.inv.patient_id }));
  return done(data.id as string, "created");
}

/**
 * Save the edits of a DRAFT claim (member, amount, tariff, pre-authorisation, and for the psychologist the ICD-10 codes). Everything is frozen once it leaves draft
 * (the database says so too). The audit row lists the names of the fields that changed.
 */
export async function updateClaim(rawId: unknown, values: Values): Promise<ActionState> {
  const me = await requireRole([...STAFF]);
  const sb = await supabaseServer();
  const ctx = await loadClaim(sb, rawId);
  if (!ctx) return NOT_FOUND;
  const { claim, patientId } = ctx;
  if (claim.status !== "draft") return { error: "Only a draft claim can be edited." };
  const p = parseClaimForm(values);
  if (!p.ok) return { error: p.error, field: p.field };
  const f = p.value;
  const before = [...(claim.icd10_codes ?? [])].sort().join(","), after = [...f.icd10].sort().join(",");
  if (me.role !== "psychologist" && before !== after) return { error: "Diagnosis codes are added by the practitioner.", field: "icd10" };

  const found = await claimableInvoice(sb, claim.invoice_id, claim.id);
  if ("error" in found) return { error: found.error };
  if (f.amount > found.remaining) return { error: `That is more than the medical aid portion still to claim (${formatZar(found.remaining)}).`, field: "amount" };
  if (f.memberId !== claim.member_id) {
    const member = await memberOf(sb, f.memberId, patientId);
    if (!member) return { error: CLAIM_ERROR.member_patient_mismatch, field: "memberId" };
    if (!isCurrentMember(member, sastDate(new Date()))) return { error: "That medical aid membership is not current. Check its dates on the patient's Medical aid tab.", field: "memberId" };
  }

  const patch: Record<string, unknown> = {};
  if (f.memberId !== claim.member_id) patch.member_id = f.memberId;
  if (f.amount !== claim.claimed_cents) patch.claimed_cents = f.amount;
  if (f.tariff !== claim.tariff_code) patch.tariff_code = f.tariff;
  if ((f.preauth ?? null) !== (claim.preauth_ref ?? null)) patch.preauth_ref = f.preauth ?? null;
  if (me.role === "psychologist" && before !== after) patch.icd10_codes = f.icd10; // never sent for the admin
  if (Object.keys(patch).length === 0) return done(claim.id, "saved");
  const { data, error } = await sb.from("claims").update(patch).eq("id", claim.id).eq("status", "draft").select("id");
  if (error) return { error: claimErrorText(error.message), field: error.message.includes("unknown_icd10") ? "icd10" : undefined };
  if (!data?.length) return STALE;
  await safely("claim.update", () => audit("claim.update", "claims", claim.id, { ...ids(claim, patientId), fields: Object.keys(patch) }));
  return done(claim.id, "saved");
}

/**
 * Shared by markSubmitted (draft) and resubmit (rejected): the APP requires at least one ICD-10 code, a current member and an amount before a claim may go
 * out (the database does not), then moves it to submitted. The claim reference, when given, is recorded. The page that offers the button shows the same checks.
 */
async function send(rawId: unknown, values: Values, kind: "submit" | "resubmit"): Promise<ActionState> {
  const me = await requireRole([...STAFF]);
  const sb = await supabaseServer();
  const ctx = await loadClaim(sb, rawId);
  if (!ctx) return NOT_FOUND;
  const { claim, patientId } = ctx;
  if (claim.status !== ACTION_FROM[kind]) return STALE;
  const ref = parseClaimRef(values);
  if (!ref.ok) return { error: ref.error, field: "claim_ref" };

  const member = await memberOf(sb, claim.member_id, patientId);
  const ready = submitReadiness({ icdCount: claim.icd10_codes?.length ?? 0, memberCurrent: !!member && isCurrentMember(member, sastDate(new Date())), claimedCents: claim.claimed_cents, role: me.role });
  if (!ready.ok) return { error: `This claim is not ready to be marked as submitted. ${ready.missing.join(" ")}` };

  const patch: Record<string, unknown> = { status: ACTION_TO[kind] };
  if (ref.value.claimRef) patch.claim_ref = ref.value.claimRef;
  const { data, error } = await sb.from("claims").update(patch).eq("id", claim.id).eq("status", ACTION_FROM[kind]).select("id");
  if (error) return { error: claimErrorText(error.message) };
  if (!data?.length) return STALE;
  await safely(`claim.${kind}`, () => audit(kind === "submit" ? "claim.submit" : "claim.resubmit", "claims", claim.id, ids(claim, patientId)));
  return done(claim.id, kind === "submit" ? "submitted" : "resubmitted");
}
export async function markSubmitted(rawId: unknown, values: Values): Promise<ActionState> { return send(rawId, values, "submit"); }
/** rejected -> submitted again, unchanged (the history stays in claim_events). To change the claim first, use returnToDraft. */
export async function resubmit(rawId: unknown, values: Values): Promise<ActionState> { return send(rawId, values, "resubmit"); }

/**
 * submitted (or part paid, while no approved amount is recorded) -> accepted, with the amount the scheme approved (never more than was claimed).
 * If the scheme has already paid at least that much, the database makes the claim paid in the same step (0020) and the notice says so.
 */
export async function markAccepted(rawId: unknown, values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const sb = await supabaseServer();
  const ctx = await loadClaim(sb, rawId);
  if (!ctx) return NOT_FOUND;
  const { claim, patientId } = ctx;
  if (!ACCEPT_FROM.includes(claim.status as ClaimStatus) || (claim.status === "part_paid" && claim.approved_cents !== null)) return STALE;
  const a = parseApproved(values);
  if (!a.ok) return { error: a.error, field: "approved" };
  if (a.value.approvedCents > claim.claimed_cents) return { error: `The approved amount cannot be more than the amount claimed (${formatZar(claim.claimed_cents)}).`, field: "approved" };
  const { data, error } = await sb.from("claims").update({ status: ACTION_TO.accept, approved_cents: a.value.approvedCents }).eq("id", claim.id).eq("status", claim.status).select("id, status");
  if (error) return { error: claimErrorText(error.message) };
  if (!data?.length) return STALE;
  await safely("claim.accept", () => audit("claim.accept", "claims", claim.id, ids(claim, patientId)));
  return done(claim.id, (data[0] as { status: string }).status === "paid" ? "accepted_paid" : "accepted");
}

/** submitted -> rejected, with a reason. The database logs the reason in claim_events and raises the follow-up task (0019); the audit row carries no reason. */
export async function markRejected(rawId: unknown, values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const sb = await supabaseServer();
  const ctx = await loadClaim(sb, rawId);
  if (!ctx) return NOT_FOUND;
  const { claim, patientId } = ctx;
  if (claim.status !== ACTION_FROM.reject) return STALE;
  const r = parseRejection(values);
  if (!r.ok) return { error: r.error, field: "reason" };
  const { data, error } = await sb.from("claims").update({ status: ACTION_TO.reject, rejection_reason: r.value.reason }).eq("id", claim.id).eq("status", ACTION_FROM.reject).select("id");
  if (error) return { error: claimErrorText(error.message) };
  if (!data?.length) return STALE;
  await safely("claim.reject", () => audit("claim.reject", "claims", claim.id, ids(claim, patientId)));
  return done(claim.id, "rejected");
}

/** rejected -> draft, so the codes, amount and tariff can be corrected before it is submitted again. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function returnToDraft(rawId: unknown, _values?: Values): Promise<ActionState> { // _values: submitted by the confirmation form, unused
  await requireRole([...STAFF]);
  const sb = await supabaseServer();
  const ctx = await loadClaim(sb, rawId);
  if (!ctx) return NOT_FOUND;
  const { claim, patientId } = ctx;
  if (claim.status !== ACTION_FROM.reopen) return STALE;
  const { data, error } = await sb.from("claims").update({ status: ACTION_TO.reopen }).eq("id", claim.id).eq("status", ACTION_FROM.reopen).select("id");
  if (error) return { error: claimErrorText(error.message) };
  if (!data?.length) return STALE;
  await safely("claim.reopen", () => audit("claim.reopen", "claims", claim.id, ids(claim, patientId)));
  return done(claim.id, "reopened");
}

/**
 * The scheme paid something: record_scheme_remittance(p_claim, p_amount, p_ref). The reference (the remittance advice number) is required; sending the same
 * reference and amount for the same claim again records nothing twice. The database moves the claim to part paid / paid, adds the payment to the invoice
 * and audits it (claim.remittance), so there is no app-level audit here.
 */
export async function recordRemittance(rawId: unknown, values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const sb = await supabaseServer();
  const ctx = await loadClaim(sb, rawId);
  if (!ctx) return NOT_FOUND;
  const { claim } = ctx;
  const p = parseRemittance(values);
  if (!p.ok) return { error: p.error, field: p.field };

  // No pre-checks on purpose: the database looks at the replay of a reference first, so a repeated submit stays a quiet no-op.
  // We only look first to tell the person that nothing new was recorded (the same reference and amount on this claim again).
  const { data: prior } = await sb.from("claim_payments").select("amount_cents").eq("claim_id", claim.id).eq("remittance_ref", p.value.ref).maybeSingle();
  const replay = !!prior && Number((prior as { amount_cents: number }).amount_cents) === p.value.amountCents;
  const { error } = await sb.rpc("record_scheme_remittance", { p_claim: claim.id, p_amount: p.value.amountCents, p_ref: p.value.ref });
  if (error) {
    const code = claimErrorCode(error.message);
    if (code === "remittance_exceeds_claim") {
      const { data: rows } = await sb.from("claim_payments").select("amount_cents").eq("claim_id", claim.id);
      const unpaid = unpaidCents(claimBasisCents(claim), (rows ?? []).reduce((s, r) => s + Number((r as { amount_cents: number }).amount_cents), 0));
      return { error: `That is more than is still unpaid on this claim (${formatZar(unpaid)}).`, field: "amount" };
    }
    if (code === "overpay") {
      const bal = await loadOutstanding(sb, claim.invoice_id).catch(() => null);
      return { error: bal ? `That is more than the invoice still owes (${formatZar(bal.outstandingCents)}).` : CLAIM_ERROR.overpay, field: "amount" };
    }
    return { error: CLAIM_ERROR[code], field: code === "ref_conflict" || code === "ref_required" ? "ref" : code === "invalid_amount" ? "amount" : undefined };
  }
  return done(claim.id, replay ? "remitted_again" : "remitted");
}

/**
 * Search the ICD-10 code list for the picker: the psychologist only, 1 to 40 characters, every word must be in the code or the description, at most 50 results
 * ordered by code, code and description only. The search text goes through the same sanitiser as the patient search and is never logged or audited.
 */
export async function searchIcd10(rawQuery: unknown): Promise<{ ok: true; codes: Icd10[] } | { ok: false; error: string }> {
  await requireRole([...PSY]);
  const q = icd10Query.safeParse(rawQuery);
  if (!q.success) return { ok: false, error: q.error.issues[0]?.message ?? "Type a code or a word to search for." };
  const words = icd10SearchWords(q.data);
  if (words.length === 0) return { ok: true, codes: [] };
  const sb = await supabaseServer();
  let query = sb.from("icd10_codes").select("code, description");
  for (const w of words) query = query.or(icd10WordFilter(w));
  const { data, error } = await query.order("code").limit(ICD10_RESULTS_MAX);
  if (error) return { ok: false, error: "We could not search the code list. Please try again." };
  return { ok: true, codes: mapIcd10Rows(data) };
}
