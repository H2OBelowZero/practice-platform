/** Result of a billing action that stays on the page: an error to show (with the id of the field it is about, when known), and `duplicate` when the database flagged a possible double entry. */
export type PayState = { error: string; field?: string; duplicate?: boolean } | null;

/** Which side of an invoice a credit note settles (credit_notes.portion, 0017): 'scheme' writes off what the medical aid will not pay, 'patient' is a discount or write-off for the patient. */
export type CreditPortion = "patient" | "scheme";
export type Credit = { portion: string; amountCents: number };
/** Sum of the credit notes of one portion; any value that is not 'scheme' counts as the patient's, as the database only ever stores the two. */
export const creditSum = (credits: readonly Credit[], portion: CreditPortion): number =>
  credits.filter((c) => (portion === "scheme") === (c.portion === "scheme")).reduce((s, c) => s + c.amountCents, 0);
