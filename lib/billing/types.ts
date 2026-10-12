/** Result of the payment action when it stays on the page: an error to show, with `duplicate` when the database flagged a possible double entry. */
export type PayState = { error: string; duplicate?: boolean } | null;
