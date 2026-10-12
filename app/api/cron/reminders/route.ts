import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";
import { runWorker, type Rpc } from "@/lib/notify/worker";

// Scheduled job (Vercel cron -> us): no session, so no requireRole. The only credential is CRON_SECRET, sent as `Authorization: Bearer <secret>`
// (Vercel adds it automatically when the variable is set). Responses are counts and short codes only: no recipients, no message content.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const json = (body: object, status: number) => NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });

/** Constant time: both sides are hashed to the same length first, so neither the content nor the length of the secret leaks through timing. */
function bearerMatches(header: string | null, secret: string): boolean {
  const a = createHash("sha256").update(header ?? "").digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

/** supabase-js rpc as the worker's Rpc: a thrown network error and an error response both become a short code. */
function serviceRpc(): Rpc {
  const sb = supabaseService();
  return async (fn, args) => {
    try {
      const { data, error } = await sb.rpc(fn, args);
      return { data, error: error ? { code: (error.code || "rpc_error").replace(/[^A-Za-z0-9_]/g, "").slice(0, 20) || "rpc_error" } : null };
    } catch { return { data: null, error: { code: "rpc_unreachable" } }; }
  };
}

async function run(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return json({ error: "misconfigured" }, 500); // never open: without a secret nobody can call this
  if (!bearerMatches(req.headers.get("authorization"), secret)) return json({ error: "unauthorized" }, 401);

  let result;
  try {
    const rpc = serviceRpc();
    result = await runWorker({ rpc });
    // one audit row per run: counts and codes only (R25: audit_append is service-role only; there is no signed-in user, so the actor is empty)
    const audited = await rpc("audit_append", { p_actor: null, p_role: "system", p_action: "cron.reminders.run", p_entity: null, p_entity_id: null, p_detail: result });
    if (audited.error) { result.errors.push(`audit_append:${audited.error.code}`); result.ok = false; }
  } catch (e) {
    console.error("cron reminders failed:", e instanceof Error ? e.name : "unknown");
    return json({ ok: false, errors: ["run_failed"] }, 500);
  }
  if (!result.ok) console.error("cron reminders finished with errors:", result.errors.join(","));
  return json(result, result.ok ? 200 : 500);
}

export const GET = run;
export const POST = run;
