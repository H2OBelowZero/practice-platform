import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Service-role helpers for setting up and inspecting rows. They are for the TEST harness only (never imported by app code) and work
// against whatever project E2E_SUPABASE_URL points at: use a throwaway staging project or a local `supabase start`, never production.
let client: SupabaseClient | undefined;
export function svc(): SupabaseClient {
  if (!client) {
    const url = process.env.E2E_SUPABASE_URL, key = process.env.E2E_SUPABASE_SERVICE_KEY;
    if (!url || !key) throw new Error("E2E_SUPABASE_URL and E2E_SUPABASE_SERVICE_KEY must be set");
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  return client;
}

/** Throw a readable error for a failed PostgREST call, otherwise return the data. */
export function must<T>(res: { data: T | null; error: { message: string; code?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.code ?? ""} ${res.error.message}`.trim());
  return res.data as T;
}

// ---- auth users ----------------------------------------------------------------------------------------------------------------------
export async function findUserId(email: string): Promise<string | null> {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await svc().auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}
/** Email confirmation bypass: mark an address confirmed through the admin API (the "Confirm email" setting stays on in the project). */
export async function confirmEmail(email: string): Promise<string> {
  const id = await findUserId(email);
  if (!id) throw new Error(`no auth user with email ${email}`);
  const { error } = await svc().auth.admin.updateUserById(id, { email_confirm: true });
  if (error) throw new Error(`confirm ${email}: ${error.message}`);
  return id;
}
export async function createConfirmedUser(email: string, password: string, name: string): Promise<string> {
  const { data, error } = await svc().auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  return data.user.id;
}

// ---- patients, appointments ------------------------------------------------------------------------------------------------------------
export async function patientIdByEmail(email: string): Promise<string> {
  const rows = must(await svc().from("patients").select("id").ilike("email", email), "patients by email");
  if (!rows?.length) throw new Error(`no patient with email ${email}`);
  return rows[0].id as string;
}

/** Book through the same RPC the app uses, as the service role (the "staff" path: no hours check). Retries the next free slot on slot_taken. */
export async function bookAt(patientId: string, typeId: string, start: Date, status: "confirmed" | "tentative" = "confirmed"): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const at = new Date(start.getTime() + i * 15 * 60_000);
    const { data, error } = await svc().rpc("book_appointment", { p_patient: patientId, p_type: typeId, p_start: at.toISOString(), p_status: status });
    if (!error) return data as string;
    if (!/slot_taken/.test(error.message)) throw new Error(`book_appointment: ${error.message}`);
  }
  throw new Error("no free slot found for the helper appointment");
}
/** A confirmed appointment that starts `minutes` from now (inside the 24 h cancellation window when minutes < 1440). */
export const bookSoon = (patientId: string, typeId: string, minutes: number) => bookAt(patientId, typeId, new Date(Date.now() + minutes * 60_000));
/** An ATTENDED appointment in the past (random day within the last year so repeated runs do not collide). */
export async function attendedAppointment(patientId: string, typeId: string): Promise<string> {
  const days = 20 + Math.floor(Math.random() * 300);
  const start = new Date(Date.now() - days * 86_400_000);
  start.setUTCHours(6 + Math.floor(Math.random() * 6), 0, 0, 0);
  const id = await bookAt(patientId, typeId, start);
  must(await svc().from("appointments").update({ status: "attended" }).eq("id", id).select("id"), "mark attended");
  return id;
}

// ---- invoices and payments -------------------------------------------------------------------------------------------------------------
/** A draft invoice with one line, then issued: the same two steps the staff screen takes. Returns the invoice id. */
export async function issuedInvoice(o: { patientId: string; appointmentId?: string; payer?: "self" | "medical_aid" | "split"; totalCents?: number; schemeCents?: number; description?: string }): Promise<string> {
  const total = o.totalCents ?? 95000, scheme = o.payer && o.payer !== "self" ? (o.schemeCents ?? Math.round(total * 0.8)) : 0;
  const inv = must(await svc().from("invoices").insert({
    patient_id: o.patientId, appointment_id: o.appointmentId ?? null, payer_type: o.payer ?? "self",
    subtotal_cents: total, total_cents: total, scheme_portion_cents: scheme, patient_portion_cents: total - scheme,
  }).select("id").single(), "insert invoice") as { id: string };
  must(await svc().from("invoice_lines").insert({ invoice_id: inv.id, description: o.description ?? "E2E consultation", quantity: 1, unit_cents: total, position: 1 }).select("id"), "insert line");
  must(await svc().from("invoices").update({ status: "issued" }).eq("id", inv.id).select("id"), "issue invoice");
  return inv.id as string;
}
export async function invoiceBalance(invoiceId: string) {
  return must(await svc().from("invoice_balances").select("status,total_cents,paid_cents,credit_cents,outstanding_cents").eq("id", invoiceId).single(), "invoice balance") as
    { status: string; total_cents: number; paid_cents: number; credit_cents: number; outstanding_cents: number };
}
export async function invoiceForAppointment(appointmentId: string) {
  const rows = must(await svc().from("invoices").select("id,number,status").eq("appointment_id", appointmentId).neq("status", "void"), "invoice for appointment");
  return rows?.[0] as { id: string; number: string; status: string } | undefined;
}
export async function paymentsOf(invoiceId: string) {
  return must(await svc().from("payments").select("id,method,amount_cents,reference,gateway_ref").eq("invoice_id", invoiceId), "payments") as
    { id: string; method: string; amount_cents: number; reference: string | null; gateway_ref: string | null }[];
}
export async function openTasks(source: string) {
  return must(await svc().from("tasks").select("id,title,status,priority,patient_id,appointment_id,source").like("source", source).eq("status", "open"), "tasks") as
    { id: string; title: string; status: string; priority: string; patient_id: string | null; appointment_id: string | null; source: string }[];
}
export async function setGuardianPay(guardianUserId: string, patientId: string, pay: boolean) {
  must(await svc().from("guardianships").update({ permissions: { book: true, forms: true, pay } }).eq("guardian_user_id", guardianUserId).eq("patient_id", patientId).select("id"), "guardian permissions");
}
