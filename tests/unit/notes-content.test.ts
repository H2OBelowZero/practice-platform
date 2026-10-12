import { describe, it, expect } from "vitest";
import { NOTE_FIELD_MAX, isEmptyNote, sanitiseContent, sanitiseRisk, wordCount } from "@/lib/notes/content";
import { templateFields, templateKeys } from "@/lib/notes/templates";
import { NOTE_ERROR, noteErrorText, noteSaveText } from "@/lib/notes/errors";
import { addendumSchema, contentSchema, createSchema, riskSchema } from "@/lib/notes/input";
import { pendingAppointments } from "@/lib/notes/pending";
import { auditActionText, auditDetailText, patientAuditFilter } from "@/lib/patients/audit-view";
import { autosaveReducer, initialAutosave } from "@/lib/forms/autosave";

describe("templates", () => {
  it("maps the seeded schemas (SOAP, DAP, Free form) to labelled fields in order", () => {
    expect(templateFields({ fields: ["subjective", "objective", "assessment", "plan"] }).map((f) => f.label)).toEqual(["Subjective", "Objective", "Assessment", "Plan"]);
    expect(templateFields({ fields: ["data", "assessment", "plan"] }).map((f) => f.key)).toEqual(["data", "assessment", "plan"]);
    const free = templateFields({ fields: ["notes"] })[0];
    expect(free.label).toBe("Session notes");
    expect(free.help.length).toBeGreaterThan(10);
    expect(free.placeholder.length).toBeGreaterThan(3);
  });
  it("unknown, repeated, malformed or non-string fields are tolerated", () => {
    expect(templateFields({ fields: ["follow_up"] })[0].label).toBe("Follow up");
    expect(templateKeys({ fields: ["plan", "plan", 4, "bad key!", "__proto__x"] })).toEqual(["plan"]);
    expect(templateKeys(null)).toEqual([]);
    expect(templateKeys({ fields: "plan" })).toEqual([]);
  });
});

describe("content", () => {
  const keys = ["subjective", "plan"];
  it("keeps only the template's fields, as strings", () => {
    expect(sanitiseContent(keys, { subjective: "a", plan: 5, extra: "x", __proto__: { evil: "1" } })).toEqual({ subjective: "a", plan: "" });
    expect(sanitiseContent(keys, null)).toEqual({ subjective: "", plan: "" });
    expect(sanitiseContent(keys, ["a"])).toEqual({ subjective: "", plan: "" });
  });
  it("cuts a value at the maximum length", () => {
    expect(sanitiseContent(["notes"], { notes: "x".repeat(NOTE_FIELD_MAX + 50) }).notes).toHaveLength(NOTE_FIELD_MAX);
  });
  it("detects an empty note (whitespace only counts as empty) and counts words", () => {
    expect(isEmptyNote({ a: "", b: "  \n " })).toBe(true);
    expect(isEmptyNote({ a: "", b: "x" })).toBe(false);
    expect(wordCount({ a: "one two  three\nfour", b: "  ", c: "five" })).toBe(5);
    expect(wordCount({})).toBe(0);
  });
  it("sanitises risk: unknown level becomes none", () => {
    expect(sanitiseRisk({ level: "high", notes: "n" })).toEqual({ level: "high", notes: "n" });
    expect(sanitiseRisk({ level: "extreme", notes: 3 })).toEqual({ level: "none", notes: "" });
    expect(sanitiseRisk(undefined)).toEqual({ level: "none", notes: "" });
  });
});

describe("input schemas", () => {
  it("refuses text over the limit instead of cutting it", () => {
    expect(contentSchema.safeParse({ notes: "x".repeat(NOTE_FIELD_MAX) }).success).toBe(true);
    expect(contentSchema.safeParse({ notes: "x".repeat(NOTE_FIELD_MAX + 1) }).success).toBe(false);
    expect(contentSchema.safeParse({ notes: 3 }).success).toBe(false);
    expect(riskSchema.safeParse({ level: "severe", notes: "" }).success).toBe(false);
    expect(riskSchema.safeParse({ level: "low", notes: "" }).success).toBe(true);
  });
  it("addendum is 1 to 20000 characters once trimmed", () => {
    expect(addendumSchema.safeParse({ content: "   " }).success).toBe(false);
    expect(addendumSchema.safeParse({}).success).toBe(false);
    expect(addendumSchema.safeParse({ content: "x".repeat(NOTE_FIELD_MAX) }).success).toBe(true);
    expect(addendumSchema.safeParse({ content: "x".repeat(NOTE_FIELD_MAX + 1) }).success).toBe(false);
  });
  it("create: template is a uuid; a blank appointment means none", () => {
    const t = "11111111-1111-4111-8111-111111111111";
    expect(createSchema.parse({ template: t, appointment: "" })).toEqual({ template: t, appointment: undefined });
    expect(createSchema.safeParse({ template: t, appointment: "nope" }).success).toBe(false);
    expect(createSchema.safeParse({ template: "x" }).success).toBe(false);
  });
});

describe("messages and autosave text", () => {
  it("maps database errors to fixed messages and never echoes them", () => {
    expect(noteErrorText("not_author")).toBe(NOTE_ERROR.notAuthor);
    expect(noteErrorText("note_not_signed")).toBe(NOTE_ERROR.notSigned);
    expect(noteErrorText("note is immutable")).toBe(NOTE_ERROR.closed);
    expect(noteErrorText('syntax error near "secret clinical text"')).toBe(NOTE_ERROR.generic);
  });
  it("status line: Saving…, Saved at HH:MM, Could not save, reload when closed", () => {
    const t = () => "10:42";
    expect(noteSaveText("saving", undefined, t)).toBe("Saving…");
    expect(noteSaveText("saved", "2030-01-01T08:42:00Z", t)).toBe("Saved at 10:42");
    expect(noteSaveText("error", undefined, t)).toMatch(/^Could not save/);
    expect(noteSaveText("conflict", undefined, t)).toMatch(/Reload/);
  });
  it("the shared reducer drives it: change, save, change during save, fail", () => {
    let s = autosaveReducer(initialAutosave, { type: "change" });
    expect(s.phase).toBe("dirty");
    s = autosaveReducer(s, { type: "save_start" });
    s = autosaveReducer(s, { type: "change" });
    s = autosaveReducer(s, { type: "save_ok", at: "x" });
    expect(s.phase).toBe("dirty"); // typed while saving: saved again
    s = autosaveReducer(s, { type: "save_start" });
    expect(autosaveReducer(s, { type: "save_fail" }).phase).toBe("error");
    expect(autosaveReducer(s, { type: "save_conflict" }).phase).toBe("conflict");
  });
});

describe("notes to complete (pure part)", () => {
  const row = (id: string, notes: string[] | null) => ({ id, clinical_notes: notes ? notes.map((state) => ({ state })) : null });
  it("keeps attended appointments with no signed or amended note", () => {
    const rows = [row("none", []), row("null", null), row("draft", ["draft"]), row("signed", ["signed"]), row("amended", ["amended"]), row("mixed", ["draft", "signed"])];
    expect(pendingAppointments(rows).map((r) => r.id)).toEqual(["none", "null", "draft"]);
  });
});

describe("patient Audit tab filter (0013)", () => {
  const P = "11111111-1111-4111-8111-111111111111", S = "22222222-2222-4222-8222-222222222222";
  it("builds the or-filter: entity ids, plus note events found by the patient id in their detail", () => {
    expect(patientAuditFilter(P, [P, S])).toBe(`entity_id.in.(${P},${S}),and(entity.eq.clinical_notes,detail->>patient_id.eq.${P})`);
  });
  it("shows note actions in words and leaves the patient id out of the detail line", () => {
    expect(auditActionText("note.view")).toBe("Opened a clinical note");
    expect(auditActionText("note.sign")).toBe("Signed a clinical note");
    expect(auditDetailText({ patient_id: P, version: true })).toBe("version: true");
  });
  it("a closed-note message says the note has already been signed", () => {
    expect(NOTE_ERROR.closed).toMatch(/^This note has already been signed/);
    expect(noteErrorText("appointment_patient_mismatch")).toBe(NOTE_ERROR.appointment);
    expect(noteErrorText('duplicate key value violates unique constraint "clinical_notes_appointment_once"')).toBe(NOTE_ERROR.exists);
  });
});
