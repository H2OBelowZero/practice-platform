import { describe, it, expect } from "vitest";
import { blockSchema, paymentSchema, practiceSchema, retentionSchema, sessionTypeSchema, settingsErrorText } from "@/lib/settings/input";
import { canEditSection, parseSection, retentionLabel, retentionSummary, sectionHref, settingsNotice, sortRetention, SECTIONS, NOTICES } from "@/lib/settings/sections";
import { cronRunFrom, integrationStatus, supabaseHost } from "@/lib/settings/env-status";

const practice = { name: "Dr Example", registrationNo: "", hpcsaNo: "PS 0123456", approvalMode: "request", cancellationWindowHours: "24", lateCancelFee: "350,00", vatRegistered: "on", vatRate: "15", crisisText: "Call SADAG 0800 567 567." };

describe("practice input", () => {
  it("parses a good form, with the fee in cents and blanks as undefined", () => {
    expect(practiceSchema.parse(practice)).toEqual({
      name: "Dr Example", registrationNo: undefined, hpcsaNo: "PS 0123456", approvalMode: "request", cancellationWindowHours: 24, lateCancelFee: 35000,
      vatRegistered: true, vatRate: 15, crisisText: "Call SADAG 0800 567 567.",
    });
    expect(practiceSchema.parse({ ...practice, vatRegistered: undefined, lateCancelFee: "0", vatRate: "14,5", cancellationWindowHours: "0" })).toMatchObject({ vatRegistered: false, lateCancelFee: 0, vatRate: 14.5, cancellationWindowHours: 0 });
  });
  const bad = (o: Record<string, unknown>) => { const r = practiceSchema.safeParse({ ...practice, ...o }); return r.success ? null : { field: String(r.error.issues[0].path[0]), message: r.error.issues[0].message }; };
  it("rejects each limit with a message on the right field", () => {
    expect(bad({ name: "  " })).toMatchObject({ field: "name" });
    expect(bad({ name: "n".repeat(121) })).toMatchObject({ field: "name" });
    expect(bad({ hpcsaNo: "1".repeat(41) })).toMatchObject({ field: "hpcsaNo" });
    expect(bad({ registrationNo: "1".repeat(41) })).toMatchObject({ field: "registrationNo" });
    expect(bad({ approvalMode: "maybe" })).toMatchObject({ field: "approvalMode" });
    expect(bad({ cancellationWindowHours: "337" })).toMatchObject({ field: "cancellationWindowHours" });
    expect(bad({ cancellationWindowHours: "-1" })).toMatchObject({ field: "cancellationWindowHours" });
    expect(bad({ cancellationWindowHours: "1.5" })).toMatchObject({ field: "cancellationWindowHours" });
    expect(bad({ cancellationWindowHours: "" })).toMatchObject({ field: "cancellationWindowHours" });
    expect(bad({ lateCancelFee: "10 000,01" })).toMatchObject({ field: "lateCancelFee" });
    expect(bad({ lateCancelFee: "abc" })).toMatchObject({ field: "lateCancelFee" });
    expect(bad({ lateCancelFee: "-5" })).toMatchObject({ field: "lateCancelFee" });
    expect(bad({ vatRate: "101" })).toMatchObject({ field: "vatRate" });
    expect(bad({ vatRate: "15,555" })).toMatchObject({ field: "vatRate" });
    expect(bad({ vatRate: "" })).toMatchObject({ field: "vatRate" });
    expect(bad({ crisisText: "   " })).toMatchObject({ field: "crisisText" });
    expect(bad({ crisisText: "c".repeat(1001) })).toMatchObject({ field: "crisisText" });
    expect(bad({ lateCancelFee: "10 000,00", vatRate: "100", cancellationWindowHours: "336", crisisText: "c".repeat(1000) })).toBeNull();
  });
});

describe("payment instructions input", () => {
  it("needs the confirmation tick and 1 to 1500 characters", () => {
    expect(paymentSchema.parse({ paymentInstructions: " Bank X\nAcc 123 ", confirmed: "on" })).toEqual({ paymentInstructions: "Bank X\nAcc 123", confirmed: true });
    expect(paymentSchema.safeParse({ paymentInstructions: "Bank X" }).success).toBe(false);
    expect(paymentSchema.safeParse({ paymentInstructions: "Bank X", confirmed: "no" }).success).toBe(false);
    expect(paymentSchema.safeParse({ paymentInstructions: "  ", confirmed: "on" }).success).toBe(false);
    expect(paymentSchema.safeParse({ paymentInstructions: "p".repeat(1501), confirmed: "on" }).success).toBe(false);
    expect(paymentSchema.safeParse({ paymentInstructions: "p".repeat(1500), confirmed: "on" }).success).toBe(true);
  });
});

describe("session type input", () => {
  const ok = { name: "Individual session", durationMin: "50", fee: "950,00", format: "in_person", bufferMin: "10", active: "on" };
  it("parses, and an unticked switch means inactive", () => {
    expect(sessionTypeSchema.parse(ok)).toEqual({ name: "Individual session", durationMin: 50, fee: 95000, format: "in_person", bufferMin: 10, active: true });
    expect(sessionTypeSchema.parse({ ...ok, active: undefined, fee: "R 1 250" })).toMatchObject({ active: false, fee: 125000 });
  });
  it("applies the same limits as the database", () => {
    const f = (o: Record<string, string>) => { const r = sessionTypeSchema.safeParse({ ...ok, ...o }); return r.success ? null : String(r.error.issues[0].path[0]); };
    expect(f({ durationMin: "4" })).toBe("durationMin");
    expect(f({ durationMin: "241" })).toBe("durationMin");
    expect(f({ durationMin: "5" })).toBeNull();
    expect(f({ durationMin: "240" })).toBeNull();
    expect(f({ fee: "10 000,01" })).toBe("fee");
    expect(f({ fee: "" })).toBe("fee");
    expect(f({ bufferMin: "121" })).toBe("bufferMin");
    expect(f({ bufferMin: "0" })).toBeNull();
    expect(f({ format: "phone" })).toBe("format");
    expect(f({ name: "" })).toBe("name");
  });
  it("has no deposit field at all (deposits are not charged in Phase 1)", () => {
    expect(Object.keys(sessionTypeSchema.shape)).not.toContain("deposit");
    expect(Object.keys(sessionTypeSchema.parse({ ...ok, deposit: "500" }))).not.toContain("deposit");
  });
});

describe("block and retention input", () => {
  it("trims the reason and limits it to 200 characters", () => {
    expect(blockSchema.parse({ starts: "2031-05-02T08:00", ends: "2031-05-02T17:00", reason: "  Leave " }).reason).toBe("Leave");
    expect(blockSchema.parse({ starts: "a", ends: "b", reason: "" }).reason).toBeUndefined();
    expect(blockSchema.safeParse({ starts: "a", ends: "b", reason: "r".repeat(201) }).success).toBe(false);
    expect(blockSchema.safeParse({ starts: "", ends: "b" }).success).toBe(false);
  });
  it("empty years means indefinitely; otherwise 1 to 100", () => {
    expect(retentionSchema.parse({ recordType: "clinical_notes", retainYears: "", legalHold: "on" })).toEqual({ recordType: "clinical_notes", retainYears: undefined, legalHold: true });
    expect(retentionSchema.parse({ recordType: "audit_log", retainYears: " 7 " })).toEqual({ recordType: "audit_log", retainYears: 7, legalHold: false });
    for (const y of ["0", "101", "-1", "1.5", "six"]) expect(retentionSchema.safeParse({ recordType: "x", retainYears: y }).success, y).toBe(false);
    expect(retentionSchema.safeParse({ recordType: "", retainYears: "5" }).success).toBe(false);
  });
});

describe("database errors become friendly sentences", () => {
  it("maps each constraint and never echoes the raw message", () => {
    expect(settingsErrorText({ message: 'conflicting key value violates exclusion constraint "overlapping_hours"' })).toMatch(/overlap/);
    expect(settingsErrorText({ message: "overlapping_hours" })).toMatch(/overlap/);
    expect(settingsErrorText({ message: 'new row for relation "practices" violates check constraint "practices_vat_range"' })).toMatch(/VAT rate/);
    expect(settingsErrorText({ message: 'violates check constraint "session_types_duration_range"' })).toMatch(/5 and 240/);
    expect(settingsErrorText({ message: 'violates check constraint "blocked_times_check"' })).toMatch(/end after/);
    expect(settingsErrorText({ message: "forbidden" })).toMatch(/Only the practitioner/);
    expect(settingsErrorText({ code: "42501", message: "x" })).toMatch(/Only the practitioner/);
    const unknown = settingsErrorText({ code: "XX000", message: "secret internal detail" });
    expect(unknown).toBe("We could not save that. Please try again.");
    expect(settingsErrorText(null)).toBe(unknown);
  });
});

describe("sections, labels and notices", () => {
  it("falls back to the first section", () => {
    expect(parseSection(undefined)).toBe("practice");
    expect(parseSection("nope")).toBe("practice");
    expect(parseSection("hours")).toBe("hours");
    expect(SECTIONS.map((s) => s.key)).toEqual(["practice", "payment", "session-types", "hours", "blocked", "retention", "information"]);
    expect(sectionHref("payment", "payment_saved")).toBe("/app/settings?section=payment&notice=payment_saved");
  });
  it("only the psychologist edits, except that the admin also manages blocked time", () => {
    for (const k of SECTIONS.map((s) => s.key)) {
      expect(canEditSection("psychologist", k), k).toBe(true);
      expect(canEditSection("admin", k), k).toBe(k === "blocked");
      for (const r of ["bookkeeper", "associate", "patient", "guardian"] as const) expect(canEditSection(r, k), `${r} ${k}`).toBe(false);
    }
  });
  it("maps retention keys to labels, keeps the known order and shows unknown keys as they are", () => {
    expect(retentionLabel("clinical_notes").label).toBe("Clinical notes");
    expect(retentionLabel("audit_log").label).toBe("Audit log");
    expect(retentionLabel("weird").label).toBe("weird");
    expect(sortRetention([{ record_type: "zeta" }, { record_type: "communications" }, { record_type: "clinical_notes" }, { record_type: "alpha" }]).map((r) => r.record_type)).toEqual(["clinical_notes", "communications", "alpha", "zeta"]);
    expect(retentionSummary(null, false)).toBe("Kept indefinitely");
    expect(retentionSummary(1, false)).toBe("Keep for 1 year");
    expect(retentionSummary(6, true)).toBe("Keep for 6 years, legal hold on");
  });
  it("only known notice keys produce text", () => {
    expect(settingsNotice("payment_saved")).toMatch(/recorded in the audit log/);
    expect(settingsNotice("<script>")).toBeNull();
    expect(settingsNotice("constructor")).toBeNull();
    expect(settingsNotice(undefined)).toBeNull();
    expect(Object.keys(NOTICES).length).toBeGreaterThan(5);
  });
});

describe("integration status", () => {
  const SECRETS = {
    EMAIL_API_KEY: "re_SECRETKEY123", EMAIL_FROM: "practice@secret-sender.example", CRON_SECRET: "cron-secret-VALUE", PAYFAST_MERCHANT_ID: "10000100", PAYFAST_MERCHANT_KEY: "46f0cd694581a",
    PAYFAST_PASSPHRASE: "passphrase-VALUE", PAYFAST_SANDBOX: "true", APP_URL: "https://private-app.example.com", SUPABASE_SERVICE_ROLE_KEY: "service-role-VALUE",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-VALUE", NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co", NODE_ENV: "production",
  };
  it("reports yes/no answers and the Supabase host, and no value appears anywhere in the result", () => {
    const s = integrationStatus(SECRETS);
    expect(s).toEqual({
      email: { configured: true, provider: "resend" }, sms: { active: false },
      payfast: { configured: true, mode: "sandbox", passphraseSet: true, merchantSet: true }, cronSecretSet: true, appUrlSet: true, supabaseHost: "abcdefgh.supabase.co",
    });
    const text = JSON.stringify(s);
    for (const [k, v] of Object.entries(SECRETS)) if (k !== "NEXT_PUBLIC_SUPABASE_URL" && k !== "PAYFAST_SANDBOX" && k !== "NODE_ENV") expect(text, k).not.toContain(v);
    expect(text).not.toContain("https://");
  });
  it("says what is missing", () => {
    const s = integrationStatus({ NODE_ENV: "production" });
    expect(s).toEqual({
      email: { configured: false, provider: "none" }, sms: { active: false },
      payfast: { configured: false, mode: "live", passphraseSet: false, merchantSet: false }, cronSecretSet: false, appUrlSet: false, supabaseHost: null,
    });
    expect(integrationStatus({ EMAIL_API_KEY: "k", NODE_ENV: "production" }).email).toEqual({ configured: false, provider: "none" }); // a key without a sender is not configured
    expect(integrationStatus({ NODE_ENV: "development" }).email).toEqual({ configured: false, provider: "console" });
    expect(integrationStatus({ SMS_ACTIVE: "true" }).sms.active).toBe(true);
    expect(integrationStatus({ PAYFAST_MERCHANT_ID: "1", PAYFAST_MERCHANT_KEY: "k", PAYFAST_SANDBOX: "true" }).payfast).toMatchObject({ configured: true, passphraseSet: false, mode: "sandbox" });
    expect(integrationStatus({ PAYFAST_MERCHANT_ID: "1", PAYFAST_MERCHANT_KEY: "k" }).payfast.configured).toBe(false); // live needs a passphrase
  });
  it("host only; garbage is null", () => {
    expect(supabaseHost("https://abc.supabase.co/rest/v1?apikey=SECRET")).toBe("abc.supabase.co");
    expect(supabaseHost("not a url")).toBeNull();
    expect(supabaseHost("")).toBeNull();
    expect(supabaseHost(undefined)).toBeNull();
  });
  it("shapes the last cron run from its audit row, counts only", () => {
    expect(cronRunFrom(null)).toBeNull();
    expect(cronRunFrom({ at: "2031-05-01T06:00:00Z", detail: { ok: true, errors: [], sent: 3 } })).toEqual({ at: "2031-05-01T06:00:00Z", ok: true, errors: 0 });
    expect(cronRunFrom({ at: "2031-05-01T06:00:00Z", detail: { ok: false, errors: ["a", "b"] } })).toEqual({ at: "2031-05-01T06:00:00Z", ok: false, errors: 2 });
    expect(cronRunFrom({ at: "2031-05-01T06:00:00Z", detail: null })).toEqual({ at: "2031-05-01T06:00:00Z", ok: null, errors: 0 });
  });
});
