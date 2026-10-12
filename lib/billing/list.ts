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
