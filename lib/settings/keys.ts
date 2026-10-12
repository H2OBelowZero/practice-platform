/** A React `key` made from the saved values of a form, so the form is rebuilt (fresh defaultValues / rows) whenever the server data it shows has changed. */
export const formKey = (...parts: unknown[]): string => parts.map((p) => String(p ?? "")).join("\u0001");
