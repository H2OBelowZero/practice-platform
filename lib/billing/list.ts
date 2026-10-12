import { PAYER_TYPES } from "@/lib/billing/input";

export const STATUS_FILTERS = [
  { value: "", label: "Any status" }, { value: "draft", label: "Draft" }, { value: "issued", label: "Issued" },
  { value: "part_paid", label: "Part paid" }, { value: "paid", label: "Paid" }, { value: "void", label: "Void" },
] as const;
export const PAYER_LABEL: Record<string, string> = { self: "Self-pay", medical_aid: "Medical aid", split: "Medical aid and patient" };
export const PAYER_FILTERS = [{ value: "", label: "Any payer" }, ...PAYER_TYPES.map((p) => ({ value: p as string, label: PAYER_LABEL[p] }))];
export const METHOD_LABEL: Record<string, string> = {
  eft: "EFT", cash: "Cash", card_machine: "Card machine", payfast: "PayFast (online)", medical_aid: "Medical aid remittance",
};
export const ROLE_LABEL: Record<string, string> = {
  psychologist: "Psychologist", admin: "Admin", bookkeeper: "Bookkeeper", associate: "Associate", patient: "Patient", guardian: "Guardian",
};

export const parseStatusFilter = (s: string | undefined): string => (STATUS_FILTERS.some((f) => f.value === s) ? (s as string) : "");
export const parsePayerFilter = (s: string | undefined): string => (PAYER_FILTERS.some((f) => f.value === s) ? (s as string) : "");
export const parseOverdueFilter = (s: string | undefined): boolean => s === "1";

/** Overdue: due before today (SAST) and still open (issued or part paid). Due today is not overdue. */
export const isOverdue = (inv: { status: string; due_date: string }, today: string): boolean =>
  (inv.status === "issued" || inv.status === "part_paid") && inv.due_date < today;

const AUDIT_TEXT: Record<string, string> = {
  "invoice.create": "Draft invoice created", "invoice.update": "Draft edited", "invoice.issue": "Invoice issued", "invoice.void": "Invoice voided",
  "payment.record": "Payment recorded", "payment.checkout_started": "Patient started an online payment", "credit_note.create": "Credit note added",
};
/** Plain wording for an audit action on an invoice; an unknown action is shown as readable text, never blank. */
export const invoiceEventText = (action: string): string => AUDIT_TEXT[action] ?? (action.replace(/[._]/g, " ").replace(/^./, (c) => c.toUpperCase()));

/** PostgREST `.or()` filter for everything the audit log holds about one invoice: its own rows, and payment / credit note rows that name it. The id must be a uuid. */
export const invoiceAuditFilter = (invoiceId: string): string =>
  `and(entity.eq.invoices,entity_id.eq.${invoiceId}),and(entity.in.(payments,credit_notes),detail->>invoice_id.eq.${invoiceId})`;
