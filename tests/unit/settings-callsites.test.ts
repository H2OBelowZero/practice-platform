import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// R34 call-site audit for the settings pages (Task 16c): every table and RPC the settings code touches is compared with the SQL (0002, 0004, 0027) and RLS, and the
// tripwires below keep the settings away from the service client, from select("*"), from audit() (the database trigger does the auditing) and from environment values.
const root = join(__dirname, "..", "..");
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, ""); // code without comments
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx|ts)$/.test(n) ? [p] : [];
  });
}
const rel = (f: string) => f.replace(root, "").replaceAll("\\", "/");
const code = ["app/app/settings", "lib/settings", "components/settings"].flatMap((d) => files(join(root, d)));
const actions = strip(read("app", "app", "settings", "actions.ts"));
const sql27 = read("supabase", "migrations", "0027_settings_audit.sql");
const sql02 = read("supabase", "migrations", "0002_booking.sql");

describe("access control", () => {
  it("the page and every exported action call requireRole before anything else", () => {
    const page = strip(read("app", "app", "settings", "page.tsx"));
    expect(page).toContain('requireRole(["psychologist", "admin"])');
    const fns = [...actions.matchAll(/export async function (\w+)\([^)]*\)[^{]*\{\s*await (requireRole\(\[\.\.\.(WRITER|BLOCKERS)\]\));/g)];
    const all = [...actions.matchAll(/export async function (\w+)/g)].map((m) => m[1]);
    expect(all.length).toBe(9);
    expect(fns.map((m) => m[1])).toEqual(all);
    const blockers = fns.filter((m) => m[3] === "BLOCKERS").map((m) => m[1]);
    expect(blockers).toEqual(["addBlock", "removeBlock"]); // the admin (receptionist) manages blocked time and nothing else
    expect(actions).toContain('const WRITER = ["psychologist"] as const;');
    expect(actions).toContain('const BLOCKERS = ["psychologist", "admin"] as const;');
  });
  it("the writers match the RLS policies: the psychologist for everything, plus the admin for blocked_times only", () => {
    expect(sql02).toMatch(/create policy st_write on session_types for all to authenticated using \(auth_role\(\)='psychologist'\)/);
    expect(sql02).toMatch(/create policy ar_write on availability_rules for all to authenticated using \(auth_role\(\)='psychologist'\)/);
    expect(sql02).toMatch(/create policy bt_staff on blocked_times for all to authenticated using \(auth_role\(\) in \('psychologist','admin'\)\)/);
    expect(read("supabase", "migrations", "0001_core.sql")).toMatch(/create policy practices_write on practices for update to authenticated using \(auth_role\(\) in \('psychologist'\)\)/);
    expect(read("supabase", "migrations", "0004_forms_tasks.sql")).toMatch(/create policy rp_psy on retention_policies for all to authenticated using \(auth_role\(\)='psychologist'\)/);
    // and the TypeScript role table agrees
    const sections = strip(read("lib", "settings", "sections.ts"));
    expect(sections).toContain('role === "psychologist" || (role === "admin" && key === "blocked")');
  });
  it("set_day_availability is guarded for the psychologist inside the function and is SECURITY INVOKER", () => {
    const fn = sql27.slice(sql27.indexOf("create function set_day_availability("));
    expect(fn.slice(0, 300)).toContain("security invoker");
    expect(fn).toMatch(/auth\.uid\(\) is not null and coalesce\(auth_role\(\)::text, ''\) <> 'psychologist' then raise exception 'forbidden'/);
    expect(sql27).toContain("revoke execute on function set_day_availability(int, jsonb) from public, anon;");
    expect(sql27).toContain("grant execute on function set_day_availability(int, jsonb) to authenticated, service_role;");
  });
});

describe("tripwires on the settings code", () => {
  it("the service client and the service key are never used (settings run as the signed-in user, under RLS)", () => {
    const bad = code.filter((f) => /supabaseService|SUPABASE_SERVICE_ROLE|supabase\/service|service_role|createClient\(/.test(strip(readFileSync(f, "utf8"))));
    expect(bad.map(rel)).toEqual([]);
  });
  it("no select(\"*\") anywhere", () => {
    for (const f of code) expect(strip(readFileSync(f, "utf8")), rel(f)).not.toMatch(/\.select\(\s*["'`]\s*\*/);
  });
  it("profiles is read in one place, for display_name and role only, and only for staff roles", () => {
    const users = code.filter((f) => /from\(\s*["'`]profiles/.test(strip(readFileSync(f, "utf8"))));
    expect(users.map(rel)).toEqual(["/lib/settings/load.ts"]);
    const load = strip(read("lib", "settings", "load.ts"));
    expect(load).toContain('.from("profiles").select("display_name, role").in("role", ["psychologist", "admin", "bookkeeper", "associate"])');
    expect(load).not.toMatch(/email|user_id/);
  });
  it("nothing in the settings code writes the audit log or sends anything: the database trigger audits, and no email is queued", () => {
    for (const f of code) {
      const c = strip(readFileSync(f, "utf8"));
      expect(c, rel(f)).not.toMatch(/@\/lib\/audit|audit\(|audit_append|audit_write/);
      expect(c, rel(f)).not.toMatch(/notifications_outbox|queueApptEmail|sendEmail/);
    }
    // the only audit_log read is the last cron run, in the loader, filtered to that one action
    const load = strip(read("lib", "settings", "load.ts"));
    expect(load.match(/from\("audit_log"\)/g)).toHaveLength(1);
    expect(load).toContain('.eq("action", "cron.reminders.run")');
  });
  it("environment variables are read in ONE place (env-status.ts), which only turns them into booleans and a host", () => {
    const readers = code.filter((f) => /process\.env/.test(strip(readFileSync(f, "utf8"))));
    expect(readers.map(rel)).toEqual(["/lib/settings/env-status.ts"]);
    const status = strip(read("lib", "settings", "env-status.ts"));
    // every property of IntegrationStatus is a boolean, a fixed word or the host
    const type = status.slice(status.indexOf("export type IntegrationStatus"), status.indexOf("export const PAYFAST_NOTIFY_PATH"));
    expect(type).not.toMatch(/: string\b(?! \| null)/);
    expect(type).toContain("supabaseHost: string | null");
    // the page shows the status object and nothing else from the environment
    expect(strip(read("app", "app", "settings", "page.tsx"))).toContain("status={integrationStatus()}");
    for (const f of code.filter((x) => !/env-status/.test(x))) expect(strip(readFileSync(f, "utf8")), rel(f)).not.toMatch(/process\.env|NEXT_PUBLIC_|API_KEY|PASSPHRASE|CRON_SECRET/);
  });
  it("the settings files are the only new routes (no route handlers, no extra pages)", () => {
    expect(files(join(root, "app", "app", "settings")).map(rel).sort()).toEqual(["/app/app/settings/actions.ts", "/app/app/settings/page.tsx"]);
  });
  it("redirects after a save are fixed paths built by sectionHref, never from the request", () => {
    for (const m of actions.matchAll(/redirect\(([^)]*)\)/g)) expect(m[1], m[0]).toMatch(/^(sectionHref\(|`\$\{sectionHref\()/);
  });
});

describe("every table and RPC call in the settings code", () => {
  const all = code.map((f) => strip(readFileSync(f, "utf8"))).join("\n");
  const tables = [...new Set([...all.matchAll(/\.from\(\s*"([a-z_]+)"\s*\)/g)].map((m) => m[1]))].sort();
  it("touches exactly these tables", () => {
    expect(tables).toEqual(["appointments", "audit_log", "availability_rules", "blocked_times", "form_templates", "practices", "profiles", "retention_policies", "session_types", "tasks"]);
  });
  it("writes only the five audited settings tables", () => {
    const written = [...new Set([...actions.matchAll(/\.from\("([a-z_]+)"\)\s*\.(?:insert|update|delete)\(/g)].map((m) => m[1]))].sort();
    expect(written).toEqual(["blocked_times", "practices", "retention_policies", "session_types"]);
    // availability_rules is written only through the RPC
    expect(actions).not.toMatch(/from\("availability_rules"\)\s*\.(?:insert|update|delete)/);
    // every written table has the audit trigger in 0027
    for (const t of [...written, "availability_rules"]) expect(sql27, t).toMatch(new RegExp(`create trigger trg_settings_audit after insert or update or delete on ${t} for each row execute function settings_audit\\(\\)`));
  });
  it("the rpc is called with exactly the SQL parameter names", () => {
    const rpcs = [...actions.matchAll(/\.rpc\("([a-z_]+)", \{([^}]*)\}\)/g)];
    expect([...new Set(rpcs.map((m) => m[1]))]).toEqual(["set_day_availability"]);
    for (const m of rpcs) expect([...m[2].matchAll(/\b(p_\w+)\s*:/g)].map((x) => x[1])).toEqual(["p_weekday", "p_windows"]);
    expect(sql27).toContain("create function set_day_availability(p_weekday int, p_windows jsonb)");
  });
  it("the columns written exist, by name, in the migrations", () => {
    const cols = ["name", "registration_no", "hpcsa_no", "approval_mode", "cancellation_window_hours", "late_cancel_fee_cents", "vat_registered", "vat_rate", "crisis_text", "payment_instructions"];
    const ddl = read("supabase", "migrations", "0001_core.sql") + read("supabase", "migrations", "0017_credit_note_portion.sql");
    for (const c of cols) expect(ddl, c).toContain(c);
    for (const c of ["name", "duration_min", "fee_cents", "format", "buffer_min", "active"]) expect(sql02, c).toContain(c);
    for (const c of ["starts_at", "ends_at", "reason"]) expect(sql02, c).toContain(c);
    expect(read("supabase", "migrations", "0004_forms_tasks.sql")).toContain("retention_policies (record_type text primary key, retain_years int, legal_hold boolean not null default false)");
  });
  it("the settings forms and actions never mention a deposit, and the database default of 0 stays", () => {
    const ui = [...files(join(root, "components", "settings")), join(root, "app", "app", "settings", "actions.ts")].map((f) => strip(readFileSync(f, "utf8"))).join("\n");
    expect(ui.toLowerCase()).not.toContain("deposit");
  });
});

describe("inactive session types stay out of booking", () => {
  it("every place patients or staff choose a session type to book filters on active, and so does the database", () => {
    const book = strip(read("app", "(public)", "book", "page.tsx"));
    expect(book).toMatch(/from\("session_types"\)[^;]*\.eq\("active", true\)/);
    expect(strip(read("app", "app", "calendar", "new", "page.tsx"))).toMatch(/from\("session_types"\)[^;]*\.eq\("active", true\)/);
    expect(strip(read("lib", "booking", "availability.ts"))).toMatch(/if \(!opts\.includeInactive\) \w+ = \w+\.eq\("active", true\)/); // the filter stays unless a caller explicitly opts out
    expect(read("supabase", "migrations", "0008_booking_hardening.sql")).toContain("from session_types where id = p_type and active");
  });
});

describe("getSlots includeInactive is for rescheduling an existing appointment only", () => {
  const callers = (dir: string) => files(join(root, dir)).filter((f) => /getSlots\(/.test(strip(readFileSync(f, "utf8"))));
  it("exactly the three reschedule paths pass it, each with the appointment's own type", () => {
    const withOpt = [...callers("app")].filter((f) => /includeInactive: true/.test(strip(readFileSync(f, "utf8")))).map(rel).sort();
    expect(withOpt).toEqual(["/app/app/calendar/[id]/reschedule/page.tsx", "/app/portal/appointments/[id]/reschedule/page.tsx", "/app/portal/appointments/actions.ts"]);
    for (const f of withOpt) expect(strip(readFileSync(join(root, f), "utf8")), f).toMatch(/getSlots\(appt\.session_type_id, .*includeInactive: true\s*\}\)/);
  });
  it("new bookings never pass it: /book, its action and calendar/new", () => {
    for (const f of [["app", "(public)", "book", "page.tsx"], ["app", "(public)", "book", "actions.ts"], ["app", "app", "calendar", "new", "page.tsx"]]) expect(strip(read(...f)), f.join("/")).not.toContain("includeInactive");
  });
});

describe("0027 itself", () => {
  it("the audit function is a pinned-search_path definer that nobody may execute, attached to all five tables", () => {
    const fn = sql27.slice(sql27.indexOf("create function settings_audit()"));
    expect(fn.slice(0, 200)).toContain("security definer set search_path = public, pg_temp");
    expect(sql27).toContain("revoke execute on function settings_audit() from public, anon, authenticated, service_role;");
    expect((sql27.match(/create trigger trg_settings_audit/g) ?? []).length).toBe(5);
  });
  it("the trigger stores names and flags only: no row value is ever put in detail", () => {
    const fn = sql27.slice(sql27.indexOf("create function settings_audit()"), sql27.indexOf("revoke execute on function settings_audit()"));
    expect(fn).toContain("jsonb_build_object('op', lower(tg_op), 'fields', to_jsonb(v_fields))");
    expect(fn).toContain("jsonb_build_object('key', r ->> 'record_type')");
    expect((fn.match(/jsonb_build_object\(/g) ?? []).length).toBe(2); // those two and nothing else
    expect(fn).not.toMatch(/'(name|crisis_text|payment_instructions|reason)',?\s*(r|n|o|new|old)\b/);
  });
});
