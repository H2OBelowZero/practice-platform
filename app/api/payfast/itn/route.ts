import { NextResponse } from "next/server";
import { supabaseService } from "@/lib/supabase/service";
import { makeItnDeps } from "@/lib/payments/itn-deps";
import { MAX_BODY_BYTES, processItn } from "@/lib/payments/itn";

// Public webhook (PayFast server -> us): no session, so no requireRole. Authenticity is the signature + PayFast IP + merchant id
// + PayFast server-side validate, all inside processItn. Nothing else is exposed: responses carry no detail.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Client IP. On Vercel the platform overwrites x-vercel-forwarded-for / x-forwarded-for with the real client address, so the
 * first entry cannot be spoofed by the caller. TRUST ASSUMPTION: behind any other proxy (or none) these headers are
 * attacker-controlled and the IP check is only as good as that proxy; the signature and PayFast validate still apply.
 */
function clientIp(req: Request): string {
  return (req.headers.get("x-vercel-forwarded-for") ?? req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
}

/** Read the body but stop (and give up) once it exceeds the limit, so a huge POST is never buffered whole. */
async function readCapped(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function POST(req: Request) {
  const sourceIp = clientIp(req);
  const rawBody = await readCapped(req);
  const env = { merchantId: process.env.PAYFAST_MERCHANT_ID?.trim(), passphrase: process.env.PAYFAST_PASSPHRASE?.trim(), sandbox: process.env.PAYFAST_SANDBOX === "true" };
  // an oversize body is still run through the core (which rejects and audits it) with a body that is over the limit
  const body = rawBody ?? "x".repeat(MAX_BODY_BYTES + 1);
  try {
    const r = await processItn(makeItnDeps(supabaseService(), env), { rawBody: body, sourceIp });
    return new NextResponse(r.body, { status: r.status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  } catch {
    // never echo internals; 500 makes PayFast retry. The raw body is never logged.
    console.error("payfast itn: unexpected failure");
    return new NextResponse("error", { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

export async function GET() {
  return new NextResponse("Method Not Allowed", { status: 405, headers: { Allow: "POST", "Cache-Control": "no-store" } });
}
