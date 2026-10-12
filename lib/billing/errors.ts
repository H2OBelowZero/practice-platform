// Database errors from the billing rules (0005, 0015) in plain language. Anything unrecognised becomes the generic text: never leak internals.
export const BILLING_ERROR = {
  appointment_has_invoice: "This appointment already has an invoice.",
  appointment_not_billable: "Only an attended appointment can be invoiced.",
  appointment_patient_mismatch: "That appointment belongs to a different patient.",
  unknown_appointment: "We could not find that appointment.",
  task_not_open: "This late cancellation fee has already been invoiced or closed.",
  zero_total: "An invoice with a total of R 0,00 cannot be issued. Add a line with an amount first.",
  portions_mismatch: "The medical aid and patient portions must add up to the invoice total. Save the draft again so they are recalculated, then issue it.",
  self_pay_has_scheme_portion: "A self-pay invoice cannot have a medical aid portion.",
  totals_mismatch: "The invoice figures did not add up, so nothing was saved. Please try again.",
  lines_mismatch: "The lines do not add up to the invoice figures, so it cannot be issued. Open the draft, check the lines and save it again.",
  lines_required: "Add at least one line to the invoice.",
  invalid_line: "A line is not valid: check the description, quantity (1 to 99) and price.",
  invoice_not_draft: "This invoice has already been issued or voided, so it can no longer be edited.",
  invoice_frozen: "This invoice has been issued, so its lines and amounts can no longer be changed.",
  invoice_lines_frozen: "This invoice has been issued, so its lines can no longer be changed.",
  invoice_void_is_final: "This invoice is void and cannot be changed.",
  invalid_invoice_transition: "That change is not allowed for this invoice in its current status. Only a draft, or an issued invoice with no payments, can be voided.",
  invoice_has_payments: "This invoice has payments recorded, so it cannot be voided. A credit note can reduce what is owed.",
  invoice_has_credits: "This invoice has credit notes. To close it, add a credit note for the remaining amount instead.",
  invoice_has_open_claims: "This invoice has a medical aid claim that has been submitted or paid, so it cannot be voided.",
  invoice_not_payable: "Payments can only be recorded on an invoice that is issued or part paid.",
  invoice_not_creditable: "A credit note can only be added to an invoice that is issued or part paid.",
  overpay: "That is more than the invoice still owes.",
  credit_exceeds_outstanding: "A credit note cannot be more than what is still owed on the invoice.",
  portion_required: "Choose whether this writes off the medical aid shortfall or is a discount for the patient.",
  portion_not_allowed: "A self-pay invoice has no medical aid portion to write off. Use a discount for the patient instead.",
  credit_exceeds_scheme_portion: "That is more than the medical aid still owes on this invoice.",
  credit_exceeds_patient_portion: "That is more than the patient still owes on this invoice.",
  ref_required: "A reference is required for an EFT or card machine payment.",
  future_date: "The date received cannot be in the future.",
  invalid_method: "Choose EFT, cash or card machine.",
  invalid_amount: "Enter an amount greater than R 0,00.",
  reason_required: "Give a reason for the credit note.",
  possible_duplicate: "A payment with the same method, amount, reference and date has already been recorded on this invoice.",
  unknown_invoice: "We could not find that invoice.",
  forbidden: "You do not have permission to do that.",
  generic: "Something went wrong and nothing was changed. Please try again.",
} as const;
export type BillingErrorCode = keyof typeof BILLING_ERROR;

// Checked top to bottom, first hit wins. (invoice_lines_frozen does not contain invoice_frozen, so their order is free.)
const MATCH: [BillingErrorCode, string][] = [
  ["appointment_has_invoice", "invoices_one_live_per_appointment"],
  ["appointment_not_billable", "appointment_not_billable"], ["appointment_patient_mismatch", "appointment_patient_mismatch"],
  ["unknown_appointment", "unknown_appointment"], ["task_not_open", "task_not_open"],
  ["zero_total", "zero_total"], ["portions_mismatch", "portions_mismatch"], ["self_pay_has_scheme_portion", "self_pay_has_scheme_portion"],
  ["totals_mismatch", "totals_mismatch"], ["lines_mismatch", "lines_mismatch"], ["lines_required", "lines_required"], ["invalid_line", "invalid_line"],
  ["invoice_not_draft", "invoice_not_draft"], ["invoice_lines_frozen", "invoice_lines_frozen"], ["invoice_frozen", "invoice_frozen"],
  ["invoice_void_is_final", "invoice_void_is_final"], ["invalid_invoice_transition", "invalid_invoice_transition"],
  ["invoice_has_payments", "invoice_has_payments"], ["invoice_has_credits", "invoice_has_credits"], ["invoice_has_open_claims", "invoice_has_open_claims"],
  ["invoice_not_payable", "invoice_not_payable"], ["invoice_not_creditable", "invoice_not_creditable"],
  ["overpay", "overpay"], ["credit_exceeds_outstanding", "credit_exceeds_outstanding"],
  ["credit_exceeds_scheme_portion", "credit_exceeds_scheme_portion"], ["credit_exceeds_patient_portion", "credit_exceeds_patient_portion"],
  ["portion_required", "portion_required"], ["portion_not_allowed", "portion_not_allowed"], ["ref_required", "ref_required"],
  ["future_date", "future_date"], ["invalid_method", "invalid_method"], ["invalid_amount", "invalid_amount"], ["reason_required", "reason_required"],
  ["possible_duplicate", "possible_duplicate"], ["unknown_invoice", "unknown_invoice"],
  ["forbidden", "forbidden"], ["forbidden", "row-level security"], ["forbidden", "permission denied"],
];

export function billingErrorCode(message: string | undefined | null): BillingErrorCode {
  const m = message ?? "";
  return MATCH.find(([, needle]) => m.includes(needle))?.[0] ?? "generic";
}
export const billingErrorText = (message: string | undefined | null): string => BILLING_ERROR[billingErrorCode(message)];
