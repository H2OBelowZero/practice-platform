import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { FOOTER, SMS_MAX, SUBJECT_MAX, TEMPLATE_NAMES, TEXT_MAX, TemplateError, absoluteLink, isTemplate, renderTemplate } from "@/lib/notify/templates";

const root = join(__dirname, "..", "..");
const BASE = "https://app.example.test";
const render = (name: string, data: object = {}) => renderTemplate(name, { date: "Mon 7 Jan 2030", time: "08:00", link: "/portal/appointments", ...data }, BASE);

// ---- static scan: every template any code queues is registered (R34 tripwire) ---------------------------------------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out); else if (/\.(ts|tsx)$/.test(f)) out.push(p);
  }
  return out;
}
const sources = [...walk(join(root, "app")), ...walk(join(root, "lib"))].filter((p) => !p.includes(join("lib", "notify")));
const read = (p: string) => readFileSync(p, "utf8");
const NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function usedTemplates() {
  const names = new Set<string>(), sites: string[] = [];
  for (const p of sources) {
    const src = read(p);
    if (/notifications_outbox/.test(src)) sites.push(relative(root, p).replace(/\\/g, "/"));
    // template: <expression> in an outbox insert (literals with an underscore; "confirmed" in a ternary is not a template)
    for (const m of src.matchAll(/\btemplate:\s*([^\n]+)/g)) for (const l of m[1].matchAll(/"([a-z0-9_]+)"/g)) if (NAME.test(l[1])) names.add(l[1]);
    // type XxxTemplate = "a" | "b";
    for (const m of src.matchAll(/type\s+\w*Template\s*=\s*([^;]+);/g)) for (const l of m[1].matchAll(/"([a-z0-9_]+)"/g)) names.add(l[1]);
    // queueApptEmail("x", ...) / queueBillingEmail("x", ...) / queueFormEmail("x", ...)
    for (const m of src.matchAll(/queue(?:Appt|Billing|Form)Email\(\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
  }
  // rows queued inside the database: insert into notifications_outbox(...) select 'email', 'reminder_24h', ...
  const migrations = join(root, "supabase", "migrations");
  for (const f of readdirSync(migrations)) {
    const sql = read(join(migrations, f));
    for (const m of sql.matchAll(/insert into notifications_outbox\s*\([^)]*\)\s*select\s*'(?:email|sms|push)',\s*'([a-z0-9_]+)'/gi)) names.add(m[1]);
  }
  return { names: [...names].sort(), sites: sites.sort() };
}

describe("template registry", () => {
  const { names, sites } = usedTemplates();

  it("the scan finds the templates the app queues today (so it cannot silently rot)", () => {
    for (const must of ["booking_confirmed", "booking_requested", "appointment_cancelled", "appointment_rescheduled", "reminder_24h", "reminder_24h_sms",
      "payment_receipt", "invoice_issued", "portal_invite", "form_requested", "form_returned"]) expect(names, must).toContain(must);
  });
  it("every template used anywhere in app/ and lib/ (and queued by SQL) is registered", () => {
    expect(names.filter((n) => !isTemplate(n))).toEqual([]);
    for (const n of names) expect(() => render(n), n).not.toThrow();
  });
  it("every registered template is used by some code (no orphans)", () => {
    expect(TEMPLATE_NAMES.filter((n) => !names.includes(n))).toEqual([]);
  });
  it("only the known files insert into the outbox; a new one must be added here after checking its template names are scanned", () => {
    expect(sites).toEqual([
      "app/(public)/book/actions.ts", "app/app/patients/actions.ts", "lib/appointments/followups.ts", "lib/billing/followups.ts", "lib/forms/queue.ts",
    ]);
  });
  it("an unknown template throws (also prototype names), and so does a non-object payload", () => {
    for (const bad of ["nope", "", "constructor", "__proto__", "toString", "REMINDER_24H"]) expect(() => render(bad), bad).toThrow(TemplateError);
    expect(() => render("nope")).toThrow(/unknown_template/);
    for (const bad of [null, undefined, "x", 5, []]) expect(() => renderTemplate("reminder_24h", bad, BASE)).toThrow(/bad_data/);
  });
});

describe("rendered messages", () => {
  it("the reminder is the agreed neutral sentence with date, time and the absolute link", () => {
    const m = render("reminder_24h");
    expect(m.subject).toBe("Appointment reminder");
    expect(m.text).toContain("You have an appointment on Mon 7 Jan 2030 at 08:00.");
    expect(m.text).toContain("Manage it here: https://app.example.test/portal/appointments");
  });
  it("every email ends with the same plain-text footer (emergency numbers, no personal information in replies)", () => {
    expect(FOOTER).toBe("This message was sent by your practice's booking system. Do not reply with personal or health information. " +
      "If this is an emergency, call 10177 or go to the nearest emergency room.");
    for (const n of TEMPLATE_NAMES.filter((x) => !x.endsWith("_sms"))) {
      const m = render(n);
      expect(m.text.endsWith(FOOTER), n).toBe(true);
      expect(m.html, n).toContain("10177");
    }
  });
  it("emails carry no mental-health context at all: the emergency footer names no support group (SADAG stays in the portal), and nothing else does either", () => {
    for (const n of TEMPLATE_NAMES) {
      const m = render(n);
      expect(`${m.subject}
${m.text}
${m.html ?? ""}`, n).not.toMatch(/sadag|depress|anxiety|mental|0800|counsel|psycholog|therap/i);
    }
  });
  it("the SMS has no footer and no html, and fits the length cap", () => {
    const m = render("reminder_24h_sms");
    expect(m.html).toBeUndefined();
    expect(m.text).toBe("Reminder: you have an appointment on Mon 7 Jan 2030 at 08:00. Manage it: https://app.example.test/portal/appointments");
    expect(m.text.length).toBeLessThanOrEqual(SMS_MAX);
  });

  // Words that would reveal the nature of the practice or a person's health to whoever glances at an inbox. The footer is checked separately
  // (it holds the generic emergency line and the words "health information").
  const FORBIDDEN = /therap|session|diagnos|psycholog|psychiat|mental|counsel|depress|anxi|treat|clinic|medic|patient|health|illness|disorder|trauma|suicid|self.?harm|\bnotes?\b|hpcsa|icd|prescri|\bdr\.?\s|invoice no|R\s?\d/i;
  it("no subject or body contains a clinical word, a title, an amount or an invoice number (footer excluded)", () => {
    for (const n of TEMPLATE_NAMES) {
      const m = render(n);
      const body = m.text.replace(FOOTER, "");
      expect(m.subject, `${n} subject`).not.toMatch(FORBIDDEN);
      expect(body, `${n} body`).not.toMatch(FORBIDDEN);
    }
  });
  it("only date, time and link are ever used: names, amounts and invoice numbers in the payload never reach the message", () => {
    const extra = { firstName: "Thandiwe", last_name: "Nkosi", patientName: "Nkosi", invoiceNumber: "INV-00042", amount: "R 950,00", practice: "Dr Example Psychology", note: "anxiety" };
    for (const n of TEMPLATE_NAMES) {
      const m = render(n, extra);
      const all = `${m.subject}\n${m.text}\n${m.html ?? ""}`;
      expect(all, n).not.toMatch(/Thandiwe|Nkosi|INV-|950|Example Psychology|anxiety/);
      expect(m, n).toEqual(render(n));
    }
  });
  it("subjects are fixed text: dynamic values never appear in them", () => {
    for (const n of TEMPLATE_NAMES) expect(render(n, { date: "UNIQUEDATE", time: "UNIQUETIME" }).subject, n).not.toMatch(/UNIQUE/);
  });
  it("length caps: subject and text stay short even with the longest accepted values", () => {
    const long = { date: "x".repeat(500), time: "y".repeat(500) };
    for (const n of TEMPLATE_NAMES) {
      const m = render(n, long); // values are cut at 40 characters, so even the SMS fits
      expect(m.subject.length, n).toBeLessThanOrEqual(SUBJECT_MAX);
      expect(m.text.length, n).toBeLessThanOrEqual(n.endsWith("_sms") ? SMS_MAX : TEXT_MAX);
    }
    expect(() => render("reminder_24h_sms", { link: "/x".padEnd(400, "a") })).toThrow(/too_long/); // an SMS that would not fit is refused, never cut
  });
  it("a missing or empty date or time is refused for the appointment templates, but not needed for the others", () => {
    for (const n of ["booking_confirmed", "booking_requested", "appointment_cancelled", "appointment_rescheduled", "reminder_24h", "reminder_24h_sms"]) {
      expect(() => renderTemplate(n, { time: "08:00", link: "/x" }, BASE), n).toThrow(/missing_field/);
      expect(() => renderTemplate(n, { date: "Mon", time: "  ", link: "/x" }, BASE), n).toThrow(/missing_field/);
    }
    for (const n of ["payment_receipt", "invoice_issued", "portal_invite", "form_requested", "form_returned"]) expect(() => renderTemplate(n, { link: "/portal/payments" }, BASE), n).not.toThrow();
  });
  it("dynamic values are HTML-escaped in the html part and control characters are removed from the text", () => {
    const m = render("reminder_24h", { date: `<script>alert("x")</script> & 'q'`, time: "08:00\r\nBcc: evil@x.test" });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;".slice(0, 40)); // date is cut at 40 characters
    expect(m.text).not.toMatch(/\r/);
    expect(m.text).not.toMatch(/\n\s*Bcc:/); // the injected header line is folded into the sentence, not a new line
  });
  it("escapes every HTML special character that survives the length cap", () => {
    const m = render("reminder_24h", { date: `<b>&"'` });
    expect(m.html).toContain("&lt;b&gt;&amp;&quot;&#39;");
    expect(m.html).not.toContain("<b>");
  });
  it("the html anchor uses the guarded absolute link, escaped", () => {
    const m = render("reminder_24h", { link: "/portal/appointments?a=1&b=2" });
    expect(m.html).toContain('href="https://app.example.test/portal/appointments?a=1&amp;b=2"');
  });
});

describe("absoluteLink guard", () => {
  it("accepts a path and prepends the app origin", () => {
    expect(absoluteLink("/portal/appointments", BASE)).toBe(`${BASE}/portal/appointments`);
    expect(absoluteLink("/register?next=/book", BASE)).toBe(`${BASE}/register?next=/book`);
    expect(absoluteLink("/", BASE)).toBe(`${BASE}/`);
  });
  it("accepts an absolute link on the app's own origin (rows queued before the worker existed)", () => {
    expect(absoluteLink(`${BASE}/portal/payments`, BASE)).toBe(`${BASE}/portal/payments`);
    expect(absoluteLink(`${BASE}/register?next=/portal/documents`, BASE)).toBe(`${BASE}/register?next=/portal/documents`);
  });
  it("refuses everything else: other hosts, look-alike hosts, protocol-relative, credentials, other schemes, whitespace, backslashes, non-strings", () => {
    const bad: unknown[] = [
      "https://evil.test/portal", "http://app.example.test/portal", // other host; same host but another scheme is another origin
      "https://app.example.test.evil.test/x", "https://app.example.test@evil.test/x", "https://user:pw@app.example.test/x",
      "//evil.test/x", "/\\evil.test", "\\\\evil.test", "javascript:alert(1)", "data:text/html,x", "mailto:a@b.test", "ftp://app.example.test/x",
      "portal/appointments", "", " /portal", "/portal x", "/portal\n", "/x\u0000", "/x".padEnd(600, "a"), null, undefined, 5, {}, ["/x"],
    ];
    for (const l of bad) expect(() => absoluteLink(l, BASE), JSON.stringify(l)).toThrow(/bad_link/);
  });
  it("renderTemplate applies the guard: a foreign link is never put in a message", () => {
    expect(() => render("reminder_24h", { link: "https://evil.test/x" })).toThrow(/bad_link/);
    expect(() => render("invoice_issued", { link: undefined })).toThrow(/bad_link/);
  });
  describe("uses APP_URL when no base is given", () => {
    afterEach(() => vi.unstubAllEnvs());
    it("reads appUrl()", () => {
      vi.stubEnv("APP_URL", "https://practice.example.co.za/");
      expect(absoluteLink("/portal")).toBe("https://practice.example.co.za/portal");
      expect(() => absoluteLink("https://app.example.test/portal")).toThrow(/bad_link/);
    });
  });
});
