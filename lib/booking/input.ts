import { z } from "zod";
import { bookingDateRange, isRealDate, sastDate } from "@/lib/time";

/** Canonical instant string as produced by generateSlots (`Date#toISOString`): lets us compare with slot strings exactly. */
const canonicalIso = z.iso.datetime().refine((s) => { const t = Date.parse(s); return !Number.isNaN(t) && new Date(t).toISOString() === s; }, "not a canonical ISO instant"); // refine also runs after a failed format check: never throw
const realDate = z.string().refine(isRealDate, "invalid date");

export const slotQuerySchema = z.object({ typeId: z.uuid(), date: realDate });
export const bookingInputSchema = z.object({ typeId: z.uuid(), startIso: canonicalIso, acceptedTerms: z.literal(true) });
export type BookingInput = z.infer<typeof bookingInputSchema>;

/** Query parameters of /book. Anything malformed becomes undefined (the page then shows the earlier step). */
export function parseBookParams(sp: { type?: string; date?: string; start?: string }) {
  const typeId = z.uuid().safeParse(sp.type).data;
  const date = realDate.safeParse(sp.date).data;
  const startIso = canonicalIso.safeParse(sp.start).data;
  return { typeId, date, startIso };
}

/** A start instant is acceptable when its SAST date lies between tomorrow and 60 days ahead. */
export function startInBookingWindow(startIso: string, now: Date): boolean {
  const { min, max } = bookingDateRange(now);
  const d = sastDate(startIso);
  return d >= min && d <= max;
}

/** Relative booking URL carrying type and start, so the journey resumes after sign-in or email confirmation. */
export function bookingUrl(typeId: string, startIso: string): string {
  return `/book?type=${encodeURIComponent(typeId)}&date=${sastDate(startIso)}&start=${encodeURIComponent(startIso)}`;
}
