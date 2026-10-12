/** The plain-language definition shown under each report (and tested: the wording is part of what the owner agreed to). */
export const DEFINITIONS = {
  incomeByMonth:
    "Invoiced = the total of invoices issued in that month, excluding drafts and void invoices (an invoice that is credited in full becomes void). Received = payments that arrived in that month, by the date the money arrived. " +
    "Credit notes = credit notes made in that month on those invoices. VAT = the VAT included in the invoiced amount. The first and last month only count the days inside the period.",
  incomeByMethod: "Money received in the period, grouped by how it was paid. Payments that are pending or failed are not counted. Medical aid = payments from a scheme, recorded from its remittance advice.",
  incomeBySessionType: "The invoiced amounts above, grouped by the type of session on the appointment each invoice was made from. Invoices made by hand, without an appointment, are shown as Other / manual.",
  debtors:
    "Debtors are invoices that were issued and are not yet fully settled. Outstanding = the invoice total minus the payments received and the credit notes made up to the date shown. Age is the number of days past the due date: " +
    "Not yet due includes invoices due today. Scheme and patient show how much of the outstanding amount the medical aid still owes and how much the patient still owes; a self-pay invoice is all patient. Void invoices never appear.",
  appointments:
    "Booked = confirmed, attended and no-show sessions that start in the period; requests still waiting for a decision are not counted. No-show rate = no-shows divided by attended plus no-shows. " +
    "Cancellation rate = cancelled divided by booked plus cancelled. A late cancellation was made less than the practice's cancellation notice period before the session (the notice period in Settings today). " +
    "Utilisation = booked minutes divided by available minutes; available minutes are the working hours for every day in the period, less blocked time, and utilisation shows n/a when no working hours are set. " +
    "These figures describe how the diary was used. They are not a measure of patient retention, engagement or outcomes.",
  activity:
    "New patients = people added in the period (prospects included). Referral source = what was recorded for those new patients; Not recorded when it was left empty. " +
    "Active caseload = patients with an attended session in the 90 days up to the end of the period. Tasks = tasks created in the period and how many of those are done now (the date a task was finished is not recorded); " +
    "clinical risk follow-ups are not counted. Claims = claims created in the period, by status. PayFast payments waiting to be matched are counted as they are now, whatever the period. " +
    "There is no waiting list in the system yet, so no waiting list figure is shown.",
  compliance:
    "These figures describe system activity, not clinical outcomes. Activity counts come from the audit log for the period and never say who or which record. Consent shows the position now for patients who are not archived; " +
    "Not recorded means no answer is on file. Failed notifications = tasks raised for emails or messages that could not be sent, created in the period. PayFast rejected = payment notifications that passed the signature check and were then refused.",
  transactions:
    "One line for every payment received in the period and one negative line for every credit note made in it, with no patient names. Reference is the bank reference, card slip number, PayFast reference or medical aid remittance number. " +
    "Bank references are copied from statements and can contain a payer's name. The VAT portion is filled in only when the practice is VAT registered, and is the invoice's VAT in proportion to the amount.",
} as const;

export const PHASE_NOTE = "Clinical outcome analytics are not part of this release. These reports cover the business side of the practice only.";
