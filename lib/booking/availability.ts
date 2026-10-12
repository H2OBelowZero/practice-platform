import "server-only";
import { supabaseServer } from "@/lib/supabase/server";
import { generateSlots } from "@/lib/booking/slots";
import { slotQuerySchema } from "@/lib/booking/input";
import { dayWindowUtc } from "@/lib/time";

const hhmm = (t: string) => t.slice(0, 5); // Postgres time "08:00:00" -> "08:00"

/**
 * Free slots (ISO instants) for a session type on a SAST calendar day.
 * Works for anonymous visitors: session_types and availability_rules are public-read, and busy_ranges is a
 * security-definer function that returns time ranges only (no patient data). Throws on malformed input (Zod).
 * An inactive session type offers no slots (new bookings), unless the caller opts in with includeInactive: true. ONLY the reschedule paths do, with the
 * appointment's own session_type_id: an appointment already booked keeps its type when the type is switched off, and must stay movable
 * (reschedule_appointment has no active check). tests/unit/settings-callsites.test.ts pins the callers.
 */
export async function getSlots(typeId: string, date: string, opts: { includeInactive?: boolean } = {}): Promise<string[]> {
  const q = slotQuerySchema.parse({ typeId, date });
  const sb = await supabaseServer();

  let typeQuery = sb.from("session_types").select("duration_min, buffer_min").eq("id", q.typeId);
  if (!opts.includeInactive) typeQuery = typeQuery.eq("active", true);
  const [type, rules] = await Promise.all([
    typeQuery.maybeSingle(),
    sb.from("availability_rules").select("weekday, start_time, end_time"),
  ]);
  if (type.error || rules.error) throw new Error("availability_unavailable");
  if (!type.data) return [];

  const { from, to } = dayWindowUtc(q.date); // the day plus one day either side, so buffers across midnight count
  const busy = await sb.rpc("busy_ranges", { p_from: from, p_to: to });
  if (busy.error) throw new Error("availability_unavailable");

  return generateSlots({
    date: q.date,
    rules: (rules.data ?? []).map((r) => ({ weekday: r.weekday, start: hhmm(r.start_time), end: hhmm(r.end_time) })),
    busy: (busy.data ?? []).map((b: { starts_at: string; ends_at: string }) => ({ start: b.starts_at, end: b.ends_at })),
    durationMin: type.data.duration_min,
    bufferMin: type.data.buffer_min,
    now: new Date(),
  });
}
