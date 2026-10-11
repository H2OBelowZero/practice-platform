export const PAGE_SIZE = 25;

/** `?page=` as a whole number from 1 up; anything else is page 1. */
export function parsePage(s: string | undefined): number {
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 1;
}

/** A relative URL with the given query parameters (empty and undefined values are left out). */
export function hrefWith(base: string, params: Record<string, string | number | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") u.set(k, String(v));
  const s = u.toString();
  return s ? `${base}?${s}` : base;
}

export const LIST_STATUS_FILTERS = [
  { value: "", label: "Current (prospects and active)" }, { value: "active", label: "Active" }, { value: "prospect", label: "Prospects" },
  { value: "archived", label: "Archived" }, { value: "all", label: "All" },
] as const;

/** The status filter from the URL: "" (current), "all", or one status. Anything else is "". */
export const parseListStatus = (s: string | undefined): string => (LIST_STATUS_FILTERS.some((f) => f.value === s) ? (s as string) : "");

/** Row range (zero-based, inclusive) of a page, and the number of pages for a total. */
export const pageRange = (page: number) => ({ from: (page - 1) * PAGE_SIZE, to: page * PAGE_SIZE - 1 });
export const pageCount = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE));
