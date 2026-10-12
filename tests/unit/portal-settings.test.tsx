import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { changedFields, mergePrefs, parsePrefsInput, prefsNotice, readPrefs } from "@/lib/portal/prefs";
import { portalNav } from "@/lib/nav";

// Pure parts first, then the page and the action with a fake "RLS-filtered" Supabase client (whatever is in h.db is what the signed-in user may read).
const h = vi.hoisted(() => ({
  requireRole: vi.fn(), audit: vi.fn(), db: {} as Record<string, unknown[]>, updates: [] as { table: string; values: unknown; filters: unknown[][] }[],
  updateResult: "ok" as "ok" | "none" | "error", readError: false, filters: [] as unknown[][],
}));
vi.mock("@/lib/auth/session", () => ({ requireRole: (...a: unknown[]) => h.requireRole(...a) }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => h.audit(...a) }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/supabase/server", () => ({
  supabaseServer: async () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let updating: unknown;
      for (const m of ["select", "order", "limit"]) q[m] = () => q;
      q.eq = (...a: unknown[]) => { h.filters.push(["eq", ...a]); return q; };
      q.update = (values: unknown) => { updating = values; h.updates.push({ table, values, filters: h.filters }); return q; };
      q.maybeSingle = async () => ({ data: h.readError ? null : (h.db[table] ?? [])[0] ?? null, error: h.readError ? { code: "XX000" } : null });
      q.then = (res: (v: unknown) => unknown) =>
        res(updating === undefined ? { data: h.db[table] ?? [], error: null }
          : h.updateResult === "error" ? { data: null, error: { code: "42501" } } : { data: h.updateResult === "none" ? [] : [{ id: "p1" }], error: null });
      return q;
    },
  }),
}));

import PortalSettings from "@/app/portal/settings/page";
import { updatePrefs } from "@/app/portal/settings/actions";

const ME = "11111111-1111-4111-8111-111111111111";
const render = async (sp: { notice?: string } = {}) => renderToStaticMarkup(await PortalSettings({ searchParams: Promise.resolve(sp) }));
const patient = (o: Record<string, unknown> = {}) => ({ id: "p1", email: "thandi@example.co.za", phone: "0821234567", comms_prefs: { email: true, sms: false }, ...o });

beforeEach(() => {
  h.requireRole.mockReset(); h.requireRole.mockResolvedValue({ userId: ME, role: "patient" });
  h.audit.mockReset(); h.audit.mockResolvedValue(undefined);
  h.db = { patients: [patient()] }; h.updates = []; h.updateResult = "ok"; h.readError = false; h.filters = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("prefs (pure)", () => {
  it("readPrefs treats only a literal true as on", () => {
    expect(readPrefs({ email: true, sms: true })).toEqual({ email: true, sms: true });
    for (const bad of [null, undefined, "x", 5, [], {}, { email: "true", sms: 1 }, { email: "yes" }]) expect(readPrefs(bad), JSON.stringify(bad)).toEqual({ email: false, sms: false });
  });
  it("parsePrefsInput: a switch is on only when it posts 'on'; any other value is a tampered form", () => {
    expect(parsePrefsInput({ email: "on", sms: "on" })).toEqual({ email: true, sms: true });
    expect(parsePrefsInput({ email: "on" })).toEqual({ email: true, sms: false });
    expect(parsePrefsInput({})).toEqual({ email: false, sms: false });
    expect(parsePrefsInput({ email: "on", other: "x" })).toEqual({ email: true, sms: false });
    for (const bad of [{ email: "true" }, { sms: "1" }, { email: "off" }, { email: true }, { email: ["on"] }]) expect(parsePrefsInput(bad), JSON.stringify(bad)).toBeNull();
    for (const notForm of [null, undefined, "on", 5]) expect(parsePrefsInput(notForm)).toEqual({ email: false, sms: false });
  });
  it("mergePrefs keeps unrelated keys and always writes real booleans", () => {
    expect(mergePrefs({ email: true, sms: false, language: "af" }, { email: false, sms: true })).toEqual({ email: false, sms: true, language: "af" });
    expect(mergePrefs(null, { email: true, sms: false })).toEqual({ email: true, sms: false });
    expect(mergePrefs([1, 2], { email: true, sms: false })).toEqual({ email: true, sms: false });
  });
  it("changedFields lists names only", () => {
    expect(changedFields({ email: true, sms: false }, { email: true, sms: false })).toEqual([]);
    expect(changedFields({ email: true, sms: false }, { email: false, sms: true })).toEqual(["email", "sms"]);
    expect(changedFields({ email: true, sms: false }, { email: true, sms: true })).toEqual(["sms"]);
  });
  it("only known notice codes render", () => {
    expect(prefsNotice("saved")).toBe("Your choices are saved.");
    for (const bad of [undefined, "", "<script>", "constructor", "__proto__"]) expect(prefsNotice(bad), String(bad)).toBeUndefined();
  });
});

describe("/portal/settings page", () => {
  it("requires a patient or guardian", async () => {
    await render();
    expect(h.requireRole).toHaveBeenCalledWith(["patient", "guardian"]);
    h.requireRole.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("shows accessible switches reflecting the stored choices, the SMS 'not active' note and the contact details read-only", async () => {
    const out = await render();
    expect(out).toMatch(/<input[^>]*id="pref-email"[^>]*type="checkbox"[^>]*role="switch"[^>]*checked=""/);
    expect(out).toMatch(/<input[^>]*id="pref-sms"[^>]*role="switch"/);
    expect(out).not.toMatch(/<input[^>]*id="pref-sms"[^>]*checked=""/);
    expect(out).toContain('for="pref-email"');
    expect(out).toContain('for="pref-sms"');
    expect(out).toContain('aria-describedby="pref-sms-hint"');
    expect(out).toContain("SMS reminders are not active yet.");
    expect(out).toContain("Email reminders");
    expect(out).toContain("thandi@example.co.za");
    expect(out).toContain("0821234567");
    expect(out).toContain("please contact the practice");
    expect(out).not.toMatch(/<input[^>]*name="(email|phone)"[^>]*type="(text|email|tel)"/); // contact details are text, not editable fields
    expect(out).toContain(">Save my choices<");
    expect(out).toMatch(/<h1[^>]*>Settings<\/h1>/);
  });
  it("shows the switch state as words as well as the drawn switch (On / Off)", async () => {
    const out = await render();
    expect(out).toContain(">On<");
    expect(out).toContain(">Off<");
  });
  it("reflects sms on / email off", async () => {
    h.db.patients = [patient({ comms_prefs: { email: false, sms: true } })];
    const out = await render();
    expect(out).toMatch(/<input[^>]*id="pref-sms"[^>]*checked=""/);
    expect(out).not.toMatch(/<input[^>]*id="pref-email"[^>]*checked=""/);
  });
  it("missing contact details say so; an account without a record explains who manages reminders", async () => {
    h.db.patients = [patient({ email: null, phone: "" })];
    expect(await render()).toContain("None on record");
    h.db.patients = [];
    const out = await render();
    expect(out).toContain("There are no reminder settings on this account.");
    expect(out).not.toContain("Save my choices");
  });
  it("reads only the signed-in person's own row (a guardian can read a child's row, but this page is the person's own)", async () => {
    await render();
    expect(h.filters).toContainEqual(["eq", "user_id", ME]);
  });
  it("a read error shows a plain message and no switches", async () => {
    h.readError = true;
    const out = await render();
    expect(out).toContain("We could not load your settings.");
    expect(out).not.toContain("pref-email");
  });
  it("a success notice shows only for the known code", async () => {
    expect(await render({ notice: "saved" })).toContain("Your choices are saved.");
    expect(await render({ notice: "<img src=x>" })).not.toContain("<img");
  });
});

describe("updatePrefs", () => {
  const run = (v: unknown) => updatePrefs(v).then((r) => `RETURN:${JSON.stringify(r)}`, (e: Error) => e.message);

  it("saves through the user's client on the user's own row, merges, audits field names only, then redirects with a notice", async () => {
    h.db.patients = [patient({ comms_prefs: { email: true, sms: false, language: "af" } })];
    expect(await run({ email: "on", sms: "on" })).toBe("REDIRECT:/portal/settings?notice=saved");
    expect(h.requireRole).toHaveBeenCalledWith(["patient", "guardian"]);
    expect(h.updates).toHaveLength(1);
    expect(h.updates[0]).toMatchObject({ table: "patients", values: { comms_prefs: { email: true, sms: true, language: "af" } } });
    expect(h.updates[0].filters).toEqual(expect.arrayContaining([["eq", "user_id", ME], ["eq", "id", "p1"]]));
    expect(h.audit).toHaveBeenCalledTimes(1);
    expect(h.audit).toHaveBeenCalledWith("prefs.update", "patients", "p1", { fields: ["sms"] });
    expect(JSON.stringify(h.audit.mock.calls)).not.toMatch(/thandi|0821234567|true|false/);
  });
  it("turning everything off posts nothing and saves false for both", async () => {
    await run({});
    expect(h.updates[0].values).toEqual({ comms_prefs: { email: false, sms: false } });
    expect(h.audit).toHaveBeenCalledWith("prefs.update", "patients", "p1", { fields: ["email"] });
  });
  it("an unchanged save writes no audit row", async () => {
    await run({ email: "on" });
    expect(h.updates).toHaveLength(1);
    expect(h.audit).not.toHaveBeenCalled();
  });
  it("a tampered form is refused before anything is read or written", async () => {
    expect(await run({ email: "true" })).toMatch(/RETURN:.*"error"/);
    expect(h.updates).toHaveLength(0);
  });
  it("no record of their own (a guardian) -> an error, no write", async () => {
    h.db.patients = [];
    expect(await run({ email: "on" })).toMatch(/RETURN:.*find your record/);
    expect(h.updates).toHaveLength(0);
  });
  it("an update that changes no row (RLS) or fails is reported, with no audit and no redirect", async () => {
    h.updateResult = "none";
    expect(await run({ email: "on" })).toMatch(/RETURN:.*could not save/);
    h.updateResult = "error";
    expect(await run({ email: "on" })).toMatch(/RETURN:.*could not save/);
    expect(h.audit).not.toHaveBeenCalled();
  });
  it("an audit failure does not undo or fail the save", async () => {
    h.audit.mockRejectedValue(new Error("audit down"));
    expect(await run({ sms: "on" })).toBe("REDIRECT:/portal/settings?notice=saved");
  });
  it("the gate runs first: a role without access never reaches the database", async () => {
    h.requireRole.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    expect(await run({ email: "on" })).toBe("NEXT_NOT_FOUND");
    expect(h.updates).toHaveLength(0);
  });
});

describe("navigation", () => {
  it("the main portal navigation keeps its four items; Settings is a header link", () => {
    expect(portalNav().map((i) => i.label)).toEqual(["Home", "Appointments", "Documents", "Payments"]);
    const layout = readFileSync(join(__dirname, "..", "..", "app", "portal", "layout.tsx"), "utf8");
    expect(layout).toContain('href="/portal/settings"');
    expect(layout.match(/<SettingsLink \/>/g)?.length).toBe(2); // desktop and phone header
  });
});
