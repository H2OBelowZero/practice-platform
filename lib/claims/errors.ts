// Database errors from the claim rules (0005, 0019) in plain language. Anything unrecognised becomes the generic text: never leak internals
// (and never echo a message that could hold a code, a reference or a reason).
export const CLAIM_ERROR = {
  invoice_not_claimable: "A claim can only be made on an issued or part paid invoice that the medical aid pays (fully or in part).",
  claims_exceed_scheme_portion: "The claims on this invoice would add up to more than the medical aid portion. Lower the amount, or reject or correct the other claim first.",
  claim_exceeds_scheme_portion: "That is more than the medical aid portion of the invoice.",
  unknown_icd10: "One of the diagnosis codes is not in the practice's code list. Remove it and choose a code from the list.",
  unknown_member: "We could not find that medical aid member.",
  member_patient_mismatch: "That medical aid member belongs to a different patient.",
  unknown_invoice: "We could not find that invoice.",
  unknown_claim: "We could not find that claim.",
  claim_link_frozen: "The invoice and member of a claim cannot be changed once it has been submitted. Return it to draft first if it was rejected.",
  claim_amount_frozen: "The amount cannot be changed once a claim has been submitted. Return it to draft first if it was rejected.",
  claim_frozen: "The diagnosis codes and tariff code cannot be changed once a claim has been submitted. Return it to draft first if it was rejected.",
  invalid_claim_transition: "That change is not allowed for this claim in its current status. Please refresh the page.",
  claim_must_start_as_draft: "A new claim always starts as a draft.",
  rejection_reason_required: "Give the reason the claim was rejected.",
  claim_not_payable: "A scheme payment can only be recorded on a claim that has been submitted.",
  remittance_exceeds_claim: "That is more than is still unpaid on this claim.",
  ref_required: "Enter the remittance advice number from the scheme.",
  invalid_ref: "The remittance reference cannot contain the # character.",
  icd10_required: "Add at least one ICD-10 diagnosis code before the claim is marked as submitted.",
  claimed_amount_required: "The amount claimed must be more than R 0,00 before the claim is marked as submitted.",
  ref_conflict: "That remittance reference has already been recorded on this claim with a different amount. Check the remittance advice number and the amount.",
  invalid_amount: "Enter an amount greater than R 0,00.",
  overpay: "That is more than the invoice still owes, after other payments and credit notes.",
  invoice_not_payable: "The invoice is no longer open for payments (it may be paid, void or still a draft).",
  claim_has_payments: "The scheme has already paid on this claim, so it cannot be submitted again, rejected or returned to draft. Record further payments, or correct a wrong payment with a credit note or an adjustment on the invoice.",
  claimed_below_remitted: "The amount claimed cannot be less than what the scheme has already paid.",
  approved_frozen: "The approved amount can only be set when the claim is marked as accepted.",
  approved_below_remitted: "The approved amount is less than the scheme has already paid on this claim. Use an approved amount of at least what was paid, or correct the payments already recorded with a credit note or an adjustment on the invoice.",
  amount_over_claimed: "The approved amount cannot be more than the amount claimed.",
  invalid_check_amount: "Enter an amount of R 0,00 or more.",
  forbidden: "You do not have permission to do that.",
  generic: "Something went wrong and nothing was changed. Please try again.",
} as const;
export type ClaimErrorCode = keyof typeof CLAIM_ERROR;

// Checked top to bottom, first hit wins.
const MATCH: [ClaimErrorCode, string][] = [
  ["invoice_not_claimable", "invoice_not_claimable"], ["claims_exceed_scheme_portion", "claims_exceed_scheme_portion"],
  ["claim_exceeds_scheme_portion", "claim_exceeds_scheme_portion"], ["unknown_icd10", "unknown_icd10"],
  ["unknown_member", "unknown_member"], ["member_patient_mismatch", "member_patient_mismatch"],
  ["unknown_invoice", "unknown_invoice"], ["unknown_claim", "unknown_claim"],
  ["claim_link_frozen", "claim_link_frozen"], ["claim_amount_frozen", "claim_amount_frozen"], ["claim_frozen", "claim_frozen"],
  ["invalid_claim_transition", "invalid_claim_transition"], ["claim_must_start_as_draft", "claim_must_start_as_draft"],
  ["rejection_reason_required", "rejection_reason_required"], ["claim_not_payable", "claim_not_payable"],
  ["remittance_exceeds_claim", "remittance_exceeds_claim"], ["ref_required", "ref_required"], ["invalid_ref", "invalid_ref"],
  ["icd10_required", "icd10_required"], ["claim_has_payments", "claim_has_payments"], ["claimed_below_remitted", "claimed_below_remitted"],
  ["approved_frozen", "approved_frozen"], ["approved_below_remitted", "approved_below_remitted"], ["claimed_amount_required", "claimed_amount_required"],
  ["ref_conflict", "ref_conflict"], ["ref_conflict", "duplicate_ref"], ["invalid_amount", "invalid_amount"],
  ["overpay", "overpay"], ["invoice_not_payable", "invoice_not_payable"], ["amount_over_claimed", `violates check constraint "claims_check"`],
  ["invalid_check_amount", `violates check constraint "claims_claimed_cents_check"`], ["invalid_check_amount", `violates check constraint "claims_approved_cents_check"`],
  ["forbidden", "forbidden"], ["forbidden", "row-level security"], ["forbidden", "permission denied"],
];

export function claimErrorCode(message: string | undefined | null): ClaimErrorCode {
  const m = message ?? "";
  return MATCH.find(([, needle]) => m.includes(needle))?.[0] ?? "generic";
}
export const claimErrorText = (message: string | undefined | null): string => CLAIM_ERROR[claimErrorCode(message)];
