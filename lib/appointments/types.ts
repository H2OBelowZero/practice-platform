/** Result of a server action that stays on the page: an error message to show, or null before the first submit. Success redirects. */
export type ActionState = { error: string; field?: string } | null;
/** Form values from a client form, passed to a server action as a plain object (always validated with Zod on the server). */
export type Values = Record<string, string>;
