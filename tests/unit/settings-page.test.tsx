import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Query, Result } from "../stubs/fake-supabase";

// The settings page and its server actions with a fake RLS client: whatever the resolver returns is what the signed-in user may read.
// 2031-03-10T07:30:00Z is 09:30 SAST on Monday 10 March 2031.
const h = vi.hoisted(() => ({ role: "psychologist", resolve: (() => ({})) as (q: Query) => Result, log: [] as Query[] }));
vi.mock("@/lib/auth/session", () => ({
  requireRole: async (allowed: string[]) => { if (!allowed.includes(h.role)) throw new Error("NOT_FOUND"); return { userId: "me", role: h.role }; },
}));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); }, notFound: () => { throw new Error("NOT_FOUND"); } }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => (await import("../stubs/fake-supabase")).fakeSupabase((q) => h.resolve(q), h.log) }));

import SettingsPage from "@/app/app/settings/page";
import { addBlock, copyMondayToWeekdays, createSessionType, removeBlock, saveDay, updatePaymentInstructions, updatePractice, updateRetention, updateSessionType } from "@/app/app/settings/actions";

const PR = "11111111-2222-4333-8444-555555555555", T1 = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d", T2 = "4a6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d", B1 = "5b6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d";
const practice = { id: PR, name: "Dr Example Psychology", registration_no: null, hpcsa_no: "PS 0123456", approval_mode: "request", cancellation_window_hours: 24, late_cancel_fee_cents: 35000, vat_registered: false, vat_rate: "15.00", crisis_text: "Call SADAG 0800 567 567 or go to the nearest ER." };
const PAYMENT = "Account holder: Dr Example\nBank: Example Bank\nAccount: 1234567890\nBranch: 250655";

const sel = (q: Query) => String(q.calls.find((c) => c.m === "select")?.a[0] ?? "");
const first = (q: Query | undefined, m: string) => q?.calls.find((c) => c.m === m)?.a[0];
const find = (table: string, m?: string) => h.log.filter((q) => q.table === table && (!m || q.calls.some((c) => c.m === m)));
const consentTpl = { title: "Consent", fields: [{ key: "c1", label: "x", type: "checkbox", consentPurpose: "treatment" }, { key: "c2", label: "y", type: "checkbox", consentPurpose: "telehealth" }, { key: "t", label: "z", type: "text" }] };

const base = (q: Query): Result => {
  switch (q.table) {
    case "practices": return { data: sel(q).includes("payment_instructions") ? [{ payment_instructions: PAYMENT }] : [practice] };
    case "session_types": return { data: [
      { id: T1, name: "Individual session", duration_min: 50, fee_cents: 95000, format: "in_person", buffer_min: 10, active: true },
      { id: T2, name: "Old couples session", duration_min: 75, fee_cents: 120000, format: "video", buffer_min: 15, active: false },
    ] };
    case "availability_rules": return { data: [
      { weekday: 1, start_time: "13:00:00", end_time: "17:00:00" }, { weekday: 1, start_time: "08:00:00", end_time: "12:00:00" }, { weekday: 6, start_time: "09:00:00", end_time: "11:00:00" },
    ] };
    case "blocked_times": return { data: [{ id: B1, starts_at: "2031-03-14T06:00:00Z", ends_at: "2031-03-14T15:00:00Z", reason: "Conference" }] };
    case "appointments": return { data: [{ starts_at: "2031-03-14T07:00:00Z", ends_at: "2031-03-14T07:50:00Z" }, { starts_at: "2031-03-20T07:00:00Z", ends_at: "2031-03-20T07:50:00Z" }] };
    case "retention_policies": return { data: [
      { record_type: "communications", retain_years: null, legal_hold: false }, { record_type: "clinical_notes", retain_years: 10, legal_hold: true }, { record_type: "audit_log", retain_years: null, legal_hold: false },
    ] };
    case "form_templates": return { data: [
      { key: "informed_consent", version: 1, active: true, schema: consentTpl },
      { key: "medical_history", version: 1, active: true, schema: { title: "Health", restricted: true, fields: [] } },
    ] };
    case "profiles": return { data: [{ display_name: "Dr Example", role: "psychologist" }, { display_name: "Sam Admin", role: "admin" }] };
    case "audit_log": return { data: [{ at: "2031-03-10T05:45:00Z", detail: { ok: true, errors: [] } }] };
    case "tasks": return { count: 2 };
    default: return {};
  }
};

const page = async (sp: Record<string, string> = {}) => renderToStaticMarkup(await SettingsPage({ searchParams: Promise.resolve(sp) }));
const redirectOf = async (p: Promise<unknown>) => { try { await p; return "no redirect"; } catch (e) { return (e as Error).message; } };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2031-03-10T07:30:00Z"));
  h.role = "psychologist"; h.resolve = base; h.log.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("/app/settings access", () => {
  it("only the psychologist and the admin may open it; everyone else gets a 404 and nothing is read", async () => {
    for (const role of ["bookkeeper", "associate", "patient", "guardian"]) {
      h.role = role; h.log.length = 0;
      await expect(page(), role).rejects.toThrow("NOT_FOUND");
      expect(h.log, role).toEqual([]);
    }
  });
  it("lists the seven sections as links and marks the current one", async () => {
    const out = await page({ section: "hours" });
    for (const l of ["Practice details", "Payment instructions", "Session types", "Working hours", "Blocked time and leave", "Record retention", "Templates, staff and connections"]) expect(out).toContain(l);
    expect(out).toMatch(/href="\/app\/settings\?section=hours"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/app\/settings\?section=hours"/);
    expect(out).toContain('href="/app/settings?section=payment"');
  });
});

describe("practice details", () => {
  it("the psychologist gets the form with the saved values, a crisis-text preview and the fixed time zone", async () => {
    const out = await page();
    expect(out).toContain("Save practice details");
    expect(out).toContain('value="Dr Example Psychology"');
    expect(out).toContain('value="PS 0123456"');
    expect(out).toContain('value="350,00"');
    expect(out).toContain('value="15,00"');
    expect(out).toContain("How patients see it");
    expect(out).toContain("Call SADAG 0800 567 567 or go to the nearest ER.");
    expect(out).toContain("booking confirmation");
    expect(out).toContain("Africa/Johannesburg");
    expect(out).not.toContain("Only the practitioner can change settings");
    expect(out).not.toContain("payment_instructions"); // its own section
    expect(sel(find("practices")[0])).not.toContain("payment_instructions");
  });
  it("the admin sees the values and no form at all", async () => {
    h.role = "admin";
    const out = await page();
    expect(out).toContain("Only the practitioner can change settings");
    expect(out).toContain("Dr Example Psychology");
    expect(out).toContain("R 350,00");
    expect(out).toContain("Call SADAG 0800 567 567");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("Save practice details");
  });
  it("a failed read shows an error, not an empty form", async () => {
    h.resolve = (q) => (q.table === "practices" ? { error: { message: "boom" } } : {});
    expect(await page()).toContain("We could not load these settings");
  });
});

describe("payment instructions", () => {
  it("the psychologist gets its own form with the fraud warning, a confirmation tick and a review step", async () => {
    const out = await page({ section: "payment" });
    expect(out).toContain("Patients see this text. Criminals change bank details to redirect payments. Check it carefully");
    expect(out).toContain("Account holder: Dr Example");
    expect(out).toContain('name="confirmed"');
    expect(out).toContain("Review and save");
    expect(out).toContain("recorded in the audit log");
    expect(out).not.toContain("Save practice details");
  });
  it("the admin reads the text and cannot change it", async () => {
    h.role = "admin";
    const out = await page({ section: "payment" });
    expect(out).toContain("Only the practitioner can change settings");
    expect(out).toContain("Bank: Example Bank");
    expect(out).not.toContain("<textarea");
    expect(out).not.toContain("<form");
  });
  it("the saved notice says the change was audited", async () => {
    expect(await page({ section: "payment", notice: "payment_saved" })).toContain("This change was recorded in the audit log.");
  });
});

describe("session types", () => {
  it("lists active and inactive types with a text label, offers edit forms to the psychologist, and has no deposit field", async () => {
    const out = await page({ section: "session-types" });
    expect(out).toContain("Individual session");
    expect(out).toContain("50 minutes · R 950,00 · In person · buffer 10 minutes");
    expect(out).toContain("Inactive: not bookable");
    expect(out).toContain("Add a session type");
    expect(out).toContain("Save session type");
    expect(out.toLowerCase()).not.toContain("deposit");
    expect(out).not.toContain("Delete");
  });
  it("the admin sees the list only", async () => {
    h.role = "admin";
    const out = await page({ section: "session-types" });
    expect(out).toContain("Old couples session");
    expect(out).not.toContain("<form");
  });
});

describe("working hours", () => {
  it("shows Monday first, each day's windows sorted, the future-bookings note and the copy shortcut", async () => {
    const out = await page({ section: "hours" });
    expect(out.indexOf("Monday")).toBeLessThan(out.indexOf("Tuesday"));
    expect(out.indexOf("Saturday")).toBeLessThan(out.indexOf("Sunday"));
    expect(out).toContain("future bookings only");
    expect(out).toContain("Copy Monday&#x27;s saved hours to Tuesday to Friday");
    expect(out.indexOf('value="08:00"')).toBeLessThan(out.indexOf('value="13:00"'));
    expect(out).toContain('name="start_0"');
    expect(out).toContain("Add a window");
    expect(out).toContain("Closed. No bookings can be made on this day.");
  });
  it("the admin sees the hours as text", async () => {
    h.role = "admin";
    const out = await page({ section: "hours" });
    expect(out).toContain("08:00 to 12:00, 13:00 to 17:00");
    expect(out).toContain("Closed");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("Copy Monday");
  });
});

describe("blocked time", () => {
  it("lists upcoming blocks with SAST times, the reason and the appointments inside (with a calendar link)", async () => {
    const out = await page({ section: "blocked" });
    expect(out).toContain("Friday, 14 March 2031, 08:00 to 17:00");
    expect(out).toContain("Conference");
    expect(out).toContain("1 appointment falls inside this time");
    expect(out).toContain('href="/app/calendar?view=week&amp;date=2031-03-14"');
    expect(out).toContain("Block this time");
    const blocks = find("blocked_times")[0];
    expect(blocks.calls.find((c) => c.m === "gt")?.a).toEqual(["ends_at", "2031-03-10T07:30:00.000Z"]); // only blocks that have not ended
  });
  it("the admin manages blocked time (add and remove) while the rest stays read-only", async () => {
    h.role = "admin";
    const out = await page({ section: "blocked" });
    expect(out).toContain("Only the practitioner can change settings");
    expect(out).toContain("You can add and remove blocked time and leave.");
    expect(out).toContain("Block this time");
    expect(out).toContain("Remove");
  });
  it("after saving, the notice reports appointments inside the new block", async () => {
    const out = await page({ section: "blocked", notice: "block_added", clash: "2" });
    expect(out).toContain("The block is added.");
    expect(out).toContain("2 appointments fall inside this time");
    expect(await page({ section: "blocked", notice: "block_removed", clash: "2" })).not.toContain("appointments fall inside this time. They are not cancelled or moved automatically.</p><p><a");
  });
});

describe("retention", () => {
  it("explains that nothing is deleted automatically and shows the policies in a fixed order", async () => {
    const out = await page({ section: "retention" });
    expect(out).toContain("never deletes any record by itself");
    expect(out).toContain("six years after");
    expect(out).toContain("minors");
    expect(out.indexOf("Clinical notes")).toBeLessThan(out.indexOf("Communications"));
    expect(out).toContain("Keep for 10 years, legal hold on");
    expect(out).toContain("Kept indefinitely");
    expect(out).toContain("Legal hold");
  });
  it("the admin cannot read the table (RLS) and the page does not even ask", async () => {
    h.role = "admin";
    const out = await page({ section: "retention" });
    expect(out).toContain("visible to the practitioner only");
    expect(out).not.toContain("Clinical notes</p>");
    expect(find("retention_policies")).toEqual([]);
  });
});

describe("templates, staff and connections", () => {
  const SECRETS: Record<string, string> = {
    EMAIL_API_KEY: "re_SECRETKEY123", EMAIL_FROM: "practice@secret-sender.example", CRON_SECRET: "cron-secret-VALUE", PAYFAST_MERCHANT_KEY: "46f0cd694581aSECRET", PAYFAST_MERCHANT_ID: "10000100",
    PAYFAST_PASSPHRASE: "passphrase-VALUE", APP_URL: "https://private-app.example.com", SUPABASE_SERVICE_ROLE_KEY: "service-role-VALUE", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-VALUE",
  };
  beforeEach(() => {
    for (const [k, v] of Object.entries(SECRETS)) vi.stubEnv(k, v);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://abcdefgh.supabase.co");
    vi.stubEnv("PAYFAST_SANDBOX", "true");
  });
  it("shows templates with version, restricted flag and consent purposes, with the draft-wording note", async () => {
    const out = await page({ section: "information" });
    expect(out).toContain("Wording is draft until reviewed by the practice and a legal advisor");
    expect(out).toContain("informed_consent");
    expect(out).toContain("Restricted: psychologist only");
    expect(out).toMatch(/Treatment|treatment/);
  });
  it("lists staff by name and role only, from a narrow profiles query", async () => {
    const out = await page({ section: "information" });
    expect(out).toContain("Sam Admin");
    expect(out).toContain("Supabase dashboard");
    expect(out).not.toMatch(/[\w.]+@[\w.]+\.[a-z]{2,}/); // no email address is rendered
    const q = find("profiles")[0];
    expect(sel(q)).toBe("display_name, role");
    expect(q.calls.find((c) => c.m === "in")?.a[1]).toEqual(["psychologist", "admin", "bookkeeper", "associate"]); // never patients or guardians
  });
  it("shows yes/no connection status and the Supabase host, and never a single environment value", async () => {
    const out = await page({ section: "information" });
    expect(out).toContain("Configured (resend)");
    expect(out).toContain("sandbox");
    expect(out).toContain("abcdefgh.supabase.co");
    expect(out).toContain("/api/payfast/itn");
    for (const [k, v] of Object.entries(SECRETS)) expect(out, k).not.toContain(v);
    expect(out).not.toContain("https://");
    expect(out).not.toContain("10000100");
  });
  it("shows the last cron run and the failed-notification count (psychologist), and hides the audit-based part from the admin", async () => {
    const out = await page({ section: "information" });
    expect(out).toContain("Monday, 10 March 2031, 07:45 (no errors)");
    expect(out).toContain("2 waiting for attention");
    expect(find("audit_log").length).toBe(1);
    h.role = "admin"; h.log.length = 0;
    const adm = await page({ section: "information" });
    expect(adm).toContain("Visible to the practitioner only");
    expect(find("audit_log")).toEqual([]);
    expect(adm).toContain("Wording is draft");
  });
  it("says plainly when things are not configured", async () => {
    vi.unstubAllEnvs();
    for (const k of Object.keys(SECRETS)) vi.stubEnv(k, "");
    vi.stubEnv("NODE_ENV", "production");
    const out = await page({ section: "information" });
    expect(out).toContain("Not configured: no email is sent");
    expect(out).toContain("Not configured: patients cannot pay online");
    expect(out).toContain("Not set: reminders cannot run");
  });
});

// ---- actions -----------------------------------------------------------------------------------------------------------------------------------------
const goodPractice = { name: "Dr Example", registrationNo: "", hpcsaNo: "PS 1", approvalMode: "auto", cancellationWindowHours: "48", lateCancelFee: "400", vatRegistered: "on", vatRate: "15", crisisText: "Call 10177." };
const writes = (m: string) => h.log.filter((q) => q.calls.some((c) => c.m === m));

describe("actions: who may call them", () => {
  it("every settings write is refused for the admin, except blocked time (and everyone else is refused for blocked time too)", async () => {
    h.role = "admin";
    const refused: Promise<unknown>[] = [
      updatePractice(goodPractice), updatePaymentInstructions({ paymentInstructions: "x", confirmed: "on" }), createSessionType({}), updateSessionType(T1, {}), saveDay(1, {}), copyMondayToWeekdays(), updateRetention("clinical_notes", {}),
    ];
    for (const p of refused) await expect(p).rejects.toThrow("NOT_FOUND");
    expect(h.log).toEqual([]);
    for (const role of ["bookkeeper", "associate", "patient", "guardian"]) {
      h.role = role;
      await expect(addBlock({}), role).rejects.toThrow("NOT_FOUND");
      await expect(removeBlock(B1), role).rejects.toThrow("NOT_FOUND");
    }
    expect(h.log).toEqual([]);
  });
});

describe("actions: practice and payment instructions", () => {
  it("updatePractice validates, then updates exactly the practice fields (never payment_instructions) as the signed-in user", async () => {
    h.resolve = (q) => (q.table === "practices" && q.calls.some((c) => c.m === "update") ? { data: [{ id: PR }] } : q.table === "practices" ? { data: [{ id: PR }] } : {});
    expect(await redirectOf(updatePractice(goodPractice))).toBe("REDIRECT:/app/settings?section=practice&notice=practice_saved");
    const up = writes("update")[0];
    expect(first(up, "update")).toEqual({
      name: "Dr Example", registration_no: null, hpcsa_no: "PS 1", approval_mode: "auto", cancellation_window_hours: 48, late_cancel_fee_cents: 40000, vat_registered: true, vat_rate: 15, crisis_text: "Call 10177.",
    });
    expect(up.calls.find((c) => c.m === "eq")?.a).toEqual(["id", PR]);
    expect(Object.keys(first(up, "update") as object)).not.toContain("payment_instructions");
  });
  it("bad input comes back as a message on the field and writes nothing", async () => {
    const r = await updatePractice({ ...goodPractice, vatRate: "150" });
    expect(r).toEqual({ error: "The VAT rate must be between 0 and 100.", field: "vatRate" });
    expect(h.log).toEqual([]);
  });
  it("a database refusal is shown as a friendly sentence", async () => {
    h.resolve = (q) => (q.calls.some((c) => c.m === "update") ? { error: { code: "23514", message: 'violates check constraint "practices_vat_range"' } } : { data: [{ id: PR }] });
    expect(await updatePractice(goodPractice)).toEqual({ error: "The VAT rate must be between 0 and 100." });
  });
  it("a row that RLS hides from the user is reported as not saved", async () => {
    h.resolve = (q) => (q.calls.some((c) => c.m === "update") ? { data: [] } : { data: [{ id: PR }] });
    expect(await updatePractice(goodPractice)).toEqual({ error: "We could not save that. Please try again." });
  });
  it("payment instructions need the confirmation tick, change only that column, and queue nothing", async () => {
    h.resolve = () => ({ data: [{ id: PR }] });
    expect(await updatePaymentInstructions({ paymentInstructions: "Bank X acc 1" })).toMatchObject({ field: "confirmed" });
    expect(writes("update")).toEqual([]);
    expect(await redirectOf(updatePaymentInstructions({ paymentInstructions: "Bank X acc 1", confirmed: "on" }))).toBe("REDIRECT:/app/settings?section=payment&notice=payment_saved");
    expect(first(writes("update")[0], "update")).toEqual({ payment_instructions: "Bank X acc 1" });
    expect(h.log.map((q) => q.table).filter((t) => !["practices"].includes(t))).toEqual([]); // no outbox, no tasks, nothing else
  });
});

describe("actions: session types", () => {
  const good = { name: "Intake", durationMin: "60", fee: "1 100,50", format: "video", bufferMin: "15", active: "on" };
  it("create sends cents and never a deposit; update never deletes", async () => {
    h.resolve = () => ({ data: [{ id: T1 }] });
    expect(await redirectOf(createSessionType(good))).toBe("REDIRECT:/app/settings?section=session-types&notice=type_added");
    expect(first(writes("insert")[0], "insert")).toEqual({ name: "Intake", duration_min: 60, fee_cents: 110050, format: "video", buffer_min: 15, active: true });
    expect(await redirectOf(updateSessionType(T1, { ...good, active: "" }))).toBe("REDIRECT:/app/settings?section=session-types&notice=type_saved");
    expect(first(writes("update")[0], "update")).toMatchObject({ active: false });
    expect(writes("delete")).toEqual([]);
  });
  it("a bad id or a missing row is a friendly not-found, and bad numbers name their field", async () => {
    expect(await updateSessionType("nope", good)).toMatchObject({ error: expect.stringMatching(/could not find/) });
    h.resolve = () => ({ data: [] });
    expect(await updateSessionType(T1, good)).toMatchObject({ error: expect.stringMatching(/could not find/) });
    expect(await createSessionType({ ...good, durationMin: "3" })).toMatchObject({ field: "durationMin" });
  });
});

describe("actions: working hours", () => {
  it("saveDay validates then replaces the day through the RPC, with the DB weekday", async () => {
    h.resolve = () => ({});
    expect(await redirectOf(saveDay(6, { start_0: "09:00", end_0: "11:00", start_2: "13:00", end_2: "15:30" }))).toBe("REDIRECT:/app/settings?section=hours&notice=hours_saved");
    const rpc = h.log.find((q) => q.table === "rpc:set_day_availability")!;
    expect(first(rpc, "rpc")).toEqual({ p_weekday: 6, p_windows: [{ start: "09:00", end: "11:00" }, { start: "13:00", end: "15:30" }] });
  });
  it("an empty list closes the day; bad lists are refused before the database", async () => {
    h.resolve = () => ({});
    expect(await redirectOf(saveDay(0, {}))).toMatch(/^REDIRECT/);
    expect(first(h.log.find((q) => q.table === "rpc:set_day_availability"), "rpc")).toEqual({ p_weekday: 0, p_windows: [] });
    h.log.length = 0;
    expect(await saveDay(1, { start_0: "08:00", end_0: "12:00", start_1: "11:00", end_1: "13:00" })).toMatchObject({ error: expect.stringMatching(/overlap/) });
    expect(await saveDay(1, { start_0: "08:02", end_0: "12:00" })).toMatchObject({ error: expect.stringMatching(/5-minute/) });
    expect(await saveDay(9, {})).toMatchObject({ error: expect.stringMatching(/could not find/) });
    expect(await saveDay("x", {})).toMatchObject({ error: expect.stringMatching(/could not find/) });
    expect(h.log).toEqual([]);
  });
  it("a database overlap error is mapped to a friendly sentence", async () => {
    h.resolve = () => ({ error: { code: "P0001", message: "overlapping_hours" } });
    expect(await saveDay(1, { start_0: "08:00", end_0: "12:00" })).toEqual({ error: "Two windows on that day overlap. Make one end before the other starts." });
  });
  it("copy Monday refuses when Monday is closed, otherwise replaces Tuesday to Friday only", async () => {
    h.resolve = (q) => (q.table === "availability_rules" ? { data: [] } : {});
    expect(await copyMondayToWeekdays()).toMatchObject({ error: expect.stringMatching(/no saved hours/) });
    expect(h.log.filter((q) => q.table.startsWith("rpc:"))).toEqual([]);
    h.log.length = 0;
    h.resolve = (q) => (q.table === "availability_rules" ? { data: [{ start_time: "08:00:00", end_time: "12:00:00" }, { start_time: "13:00:00", end_time: "17:00:00" }] } : {});
    expect(await redirectOf(copyMondayToWeekdays())).toBe("REDIRECT:/app/settings?section=hours&notice=hours_copied");
    const rpcs = h.log.filter((q) => q.table === "rpc:set_day_availability").map((q) => first(q, "rpc") as { p_weekday: number; p_windows: unknown[] });
    expect(rpcs.map((r) => r.p_weekday)).toEqual([2, 3, 4, 5]);
    for (const r of rpcs) expect(r.p_windows).toEqual([{ start: "08:00", end: "12:00" }, { start: "13:00", end: "17:00" }]);
  });
});

describe("actions: blocked time and retention", () => {
  it("the admin may add a block; times are read as SAST and appointments inside are counted into the redirect", async () => {
    h.role = "admin";
    h.resolve = (q) => (q.table === "blocked_times" ? { data: [{ id: B1 }] } : q.table === "appointments" ? { count: 3 } : {});
    expect(await redirectOf(addBlock({ starts: "2031-03-14T08:00", ends: "2031-03-14T17:00", reason: "Leave" }))).toBe("REDIRECT:/app/settings?section=blocked&notice=block_added&clash=3");
    expect(first(writes("insert")[0], "insert")).toEqual({ starts_at: "2031-03-14T06:00:00.000Z", ends_at: "2031-03-14T15:00:00.000Z", reason: "Leave" });
    const appts = find("appointments")[0];
    expect(appts.calls.find((c) => c.m === "in")?.a).toEqual(["status", ["tentative", "confirmed"]]);
    expect(writes("update").filter((q) => q.table === "appointments")).toEqual([]); // appointments are never touched
  });
  it("no clash means a plain redirect; bad ranges name the field; reasons are capped", async () => {
    h.resolve = (q) => (q.table === "blocked_times" ? { data: [{ id: B1 }] } : q.table === "appointments" ? { count: 0 } : {});
    expect(await redirectOf(addBlock({ starts: "2031-03-14T08:00", ends: "2031-03-14T17:00" }))).toBe("REDIRECT:/app/settings?section=blocked&notice=block_added");
    expect(await addBlock({ starts: "2031-03-14T17:00", ends: "2031-03-14T08:00" })).toMatchObject({ field: "ends" });
    expect(await addBlock({ starts: "2031-03-01T08:00", ends: "2031-03-02T08:00" })).toMatchObject({ error: expect.stringMatching(/future/) });
    expect(await addBlock({ starts: "2031-03-14T08:00", ends: "2031-03-14T17:00", reason: "r".repeat(201) })).toMatchObject({ field: "reason" });
  });
  it("remove deletes one block by id and reports a missing one", async () => {
    h.resolve = () => ({ data: [{ id: B1 }] });
    expect(await redirectOf(removeBlock(B1))).toBe("REDIRECT:/app/settings?section=blocked&notice=block_removed");
    expect(writes("delete")[0].calls.find((c) => c.m === "eq")?.a).toEqual(["id", B1]);
    h.resolve = () => ({ data: [] });
    expect(await removeBlock(B1)).toMatchObject({ error: expect.stringMatching(/could not find/) });
    expect(await removeBlock("x")).toMatchObject({ error: expect.stringMatching(/could not find/) });
  });
  it("retention: empty years means indefinitely, the key picks the row", async () => {
    h.resolve = () => ({ data: [{ record_type: "clinical_notes" }] });
    expect(await redirectOf(updateRetention("clinical_notes", { retainYears: "", legalHold: "on" }))).toBe("REDIRECT:/app/settings?section=retention&notice=retention_saved");
    const up = writes("update")[0];
    expect(first(up, "update")).toEqual({ retain_years: null, legal_hold: true });
    expect(up.calls.find((c) => c.m === "eq")?.a).toEqual(["record_type", "clinical_notes"]);
    expect(await updateRetention("clinical_notes", { retainYears: "0" })).toMatchObject({ field: "retainYears" });
    h.resolve = () => ({ data: [] });
    expect(await updateRetention("nope", { retainYears: "5" })).toMatchObject({ error: expect.stringMatching(/could not find/) });
  });
});

describe("fix round 1: wording and keys", () => {
  it("the working-hours page says appointments cannot run past 23:55", async () => {
    expect(await page({ section: "hours" })).toContain("Appointments cannot run past 23:55.");
  });
  it("the admin banner says what the admin can see in each section, not 'everything'", async () => {
    h.role = "admin";
    const texts: Record<string, string> = {
      practice: "You can see all the practice details", payment: "You can read the payment instructions", "session-types": "You can see the session types", hours: "You can see the working hours",
      blocked: "You can add and remove blocked time and leave.", retention: "Retention settings are visible to the practitioner only", information: "the last scheduled run is visible to the practitioner only",
    };
    for (const [section, text] of Object.entries(texts)) {
      const out = await page({ section });
      expect(out, section).toContain("Only the practitioner can change settings");
      expect(out, section).toContain(text);
      expect(out, section).not.toContain("everything on this page");
    }
  });
  it("the saved-data version is in the form keys: a changed saved day or retention row renders as a different form instance", async () => {
    const { windowsKey } = await import("@/lib/settings/hours");
    const { formKey } = await import("@/lib/settings/keys");
    expect(windowsKey(1, [{ start: "08:00", end: "12:00" }])).not.toBe(windowsKey(1, [{ start: "08:00", end: "13:00" }]));
    expect(formKey("clinical_notes", 10, true)).not.toBe(formKey("clinical_notes", 10, false));
  });
  it("a crafted day form gives a friendly message, not an exception", async () => {
    const crafted = { start_0: ["x"], end_0: { a: 1 }, "start_-5": "08:00" } as unknown as Record<string, string>;
    expect(await saveDay(1, crafted)).toMatchObject({ error: expect.any(String) });
    expect(h.log).toEqual([]);
  });
});

describe("connections panel: SMS (final review, before go-live)", () => {
  it("says plainly when SMS is switched on but there is no provider to send through", async () => {
    const { InformationSection } = await import("@/components/settings/sections");
    const { integrationStatus } = await import("@/lib/settings/env-status");
    const html = (env: Record<string, string>) =>
      renderToStaticMarkup(<InformationSection templates={[]} staff={[]} status={integrationStatus(env)} cron={null} cronVisible={false} failedNotifications={null} />);
    expect(html({ SMS_ACTIVE: "true", NODE_ENV: "production" })).toContain("Switched on, but there is no SMS provider: no SMS is sent");
    expect(html({ SMS_ACTIVE: "true", NODE_ENV: "development" })).toContain("Switched on (console only: messages are logged, nothing is delivered)");
    expect(html({ NODE_ENV: "production" })).toContain("Inactive in Phase 1");
  });
});
