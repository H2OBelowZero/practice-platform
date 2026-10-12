/** Result of a billing action that stays on the page: an error to show (with the id of the field it is about, when known), and `duplicate` when the database flagged a possible double entry. */
export type PayState = { error: string; field?: string; duplicate?: boolean } | null;
