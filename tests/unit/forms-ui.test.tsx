import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AnswersView, FormRenderer, answerText, controlKind, firstErrorKey, introParagraphs } from "@/lib/forms/render";
import { AUTOSAVE_DELAY_MS, autosaveReducer, autosaveText, hasUnsaved, initialAutosave, type AutosaveAction, type AutosaveState } from "@/lib/forms/autosave";
import { draftAnswers } from "@/lib/forms/draft";
import { PURPOSE_INFO, PURPOSE_ORDER, consentFields, consentPurposesFrom, consentView, isPurpose, withdrawalCopy } from "@/lib/forms/consent";
import { guardianMayUseForms, latestPerKey, templateTitle } from "@/lib/forms/access";
import { formNotice } from "@/lib/forms/notices";
import { TEMPLATES } from "@/lib/forms/templates";
import { CONSENT_PURPOSES, checkSchema, type FormSchema } from "@/lib/forms/validate";

const schema: FormSchema = {
  title: "Test form",
  intro: "First paragraph.\n\nSecond paragraph.",
  fields: [
    { key: "name", label: "Full name", type: "text", required: true, help: "As on your ID." },
    { key: "story", label: "Your story", type: "textarea" },
    { key: "born", label: "Date of birth", type: "date", required: true },
    { key: "mood", label: "Mood", type: "select", options: ["Good", "Bad"], required: true },
    { key: "agree", label: "I consent to treatment", type: "checkbox", required: true, consentPurpose: "treatment" },
    { key: "share", label: "Share with my doctor", type: "checkbox", consentPurpose: "share_referrer" },
    { key: "private", label: "I am somewhere private", type: "checkbox" },
  ],
};
const noop = () => {};
const html = (values = {}, errors: Record<string, string> = {}) => renderToStaticMarkup(<FormRenderer schema={schema} values={values} errors={errors} onChange={noop} />);

describe("FormRenderer: field to input mapping", () => {
  it("maps every field type to its control", () => {
    expect(schema.fields.map(controlKind)).toEqual(["text", "textarea", "date", "select", "checkbox", "checkbox", "checkbox"]);
    const out = html();
    expect(out).toMatch(/<input[^>]*id="f-name"[^>]*type="text"|<input[^>]*type="text"[^>]*id="f-name"/);
    expect(out).toMatch(/<textarea[^>]*id="f-story"/);
    expect(out).toMatch(/<input[^>]*id="f-born"[^>]*type="date"|<input[^>]*type="date"[^>]*id="f-born"/);
    expect(out).toMatch(/<select[^>]*id="f-mood"/);
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*id="f-agree"|<input[^>]*id="f-agree"[^>]*type="checkbox"/);
    expect(out).toContain("<option value=\"Good\">Good</option>");
    expect(out).toMatch(/<option value="" selected="">Choose…<\/option>/);
  });

  it("every control has a label tied to it by for/id", () => {
    const out = html();
    for (const f of schema.fields) expect(out, f.key).toContain(`for="f-${f.key}"`);
  });

  it("shows the intro as separate paragraphs, the help as a hint tied by aria-describedby, and the required note", () => {
    const out = html();
    expect(out).toContain("<p>First paragraph.</p>");
    expect(out).toContain("<p>Second paragraph.</p>");
    expect(out).toContain("As on your ID.");
    expect(out).toContain('id="f-name-hint"');
    expect(out).toMatch(/id="f-name"[^>]*aria-describedby="f-name-hint"|aria-describedby="f-name-hint"[^>]*id="f-name"/);
    expect(out).toContain("Items marked with a star are required.");
  });

  it("marks required fields (visible star for sighted users, aria-required for the control) and only those", () => {
    const out = html();
    for (const k of ["name", "born", "mood", "agree"]) expect(out, k).toMatch(new RegExp(`<[^>]*id="f-${k}"[^>]*aria-required="true"|<[^>]*aria-required="true"[^>]*id="f-${k}"`));
    for (const k of ["story", "share", "private"]) expect(out, k).not.toMatch(new RegExp(`<[^>]*id="f-${k}"[^>]*aria-required|<[^>]*aria-required[^>]*id="f-${k}"`));
    expect((out.match(/aria-hidden="true" class="text-ink-muted"> \*</g) ?? []).length).toBe(4);
  });

  it("shows values: text, selected option, ticked box", () => {
    const out = html({ name: "Ann", mood: "Bad", agree: true });
    expect(out).toContain('value="Ann"');
    expect(out).toMatch(/<option value="Bad" selected/);
    expect(out).toMatch(/<input[^>]*id="f-agree"[^>]*checked|<input[^>]*checked[^>]*id="f-agree"/);
    expect(out).not.toMatch(/<input[^>]*id="f-share"[^>]*checked|<input[^>]*checked[^>]*id="f-share"/);
  });

  it("an error gives the control aria-invalid and aria-describedby pointing at a visible message with text, not colour alone", () => {
    const out = html({}, { name: "Full name is required", agree: "please tick" });
    expect(out).toMatch(/<[^>]*id="f-name"[^>]*aria-invalid="true"|<[^>]*aria-invalid="true"[^>]*id="f-name"/);
    expect(out).toContain('id="f-name-error"');
    expect(out).toMatch(/aria-describedby="f-name-hint f-name-error"/);
    expect(out).toContain("Full name is required");
    expect(out).toContain('id="f-agree-error"');
    expect(out).toMatch(/<[^>]*id="f-agree"[^>]*aria-invalid="true"|<[^>]*aria-invalid="true"[^>]*id="f-agree"/);
    expect(out).toContain("Error: "); // screen-reader prefix
    expect(html()).not.toContain("aria-invalid");
  });

  it("firstErrorKey follows the template order, not the error object order", () => {
    expect(firstErrorKey(schema, { agree: "x", mood: "y" })).toBe("mood");
    expect(firstErrorKey(schema, {})).toBeUndefined();
  });

  it("introParagraphs ignores blank paragraphs and missing intros", () => {
    expect(introParagraphs("a\n\n\n\nb\n\n ")).toEqual(["a", "b"]);
    expect(introParagraphs(undefined)).toEqual([]);
  });

  it("renders every seeded template without throwing", () => {
    for (const t of TEMPLATES) expect(renderToStaticMarkup(<FormRenderer schema={t.schema} values={{}} onChange={noop} />), t.key).toContain("f-");
  });
});

describe("read-only answers", () => {
  it("shows answers by label with Yes/No for checkboxes, long dates, and 'Not answered' for blanks", () => {
    const out = renderToStaticMarkup(<AnswersView schema={schema} answers={{ name: "Ann", born: "2031-01-06", mood: "Good", agree: true, private: false }} />);
    expect(out).toContain("Full name");
    expect(out).toContain("Ann");
    expect(out).toContain("Monday, 6 January 2031");
    expect(out).toMatch(/I consent to treatment<\/dt><dd[^>]*>Yes</);
    expect(out).toMatch(/I am somewhere private<\/dt><dd[^>]*>No</);
    expect(out).toMatch(/Your story<\/dt><dd[^>]*>Not answered</);
  });
  it("answerText", () => {
    const text = schema.fields[0];
    expect(answerText(text, "  ")).toBeNull();
    expect(answerText(text, 5)).toBeNull();
    expect(answerText(schema.fields[4], undefined)).toBeNull();
  });
  it("does not read inherited keys as answers", () => {
    const s: FormSchema = { fields: [{ key: "constructor", label: "C", type: "text" }] };
    expect(renderToStaticMarkup(<AnswersView schema={s} answers={{}} />)).toContain("Not answered");
  });
});

describe("autosave state machine", () => {
  const run = (...actions: AutosaveAction[]) => actions.reduce(autosaveReducer, initialAutosave as AutosaveState);
  it("idle -> dirty -> saving -> saved", () => {
    expect(run({ type: "change" }).phase).toBe("dirty");
    expect(run({ type: "change" }, { type: "save_start" }).phase).toBe("saving");
    const saved = run({ type: "change" }, { type: "save_start" }, { type: "save_ok", at: "2031-01-06T08:00:00Z" });
    expect(saved).toMatchObject({ phase: "saved", savedAt: "2031-01-06T08:00:00Z" });
    expect(run({ type: "change" }, { type: "save_start" }, { type: "save_ok", at: "t" }, { type: "change" }).phase).toBe("dirty");
  });
  it("a change while saving is not lost: the state is dirty again when the save lands", () => {
    const s = run({ type: "change" }, { type: "save_start" }, { type: "change" });
    expect(s.phase).toBe("saving");
    expect(autosaveReducer(s, { type: "save_ok", at: "t" }).phase).toBe("dirty");
    expect(autosaveReducer(s, { type: "save_fail" }).phase).toBe("dirty");
  });
  it("saving -> error; a retry goes error -> saving; typing goes error -> dirty", () => {
    const err = run({ type: "change" }, { type: "save_start" }, { type: "save_fail" });
    expect(err.phase).toBe("error");
    expect(autosaveReducer(err, { type: "save_start" }).phase).toBe("saving");
    expect(autosaveReducer(err, { type: "change" }).phase).toBe("dirty");
  });
  it("stray events are ignored (no save to land, nothing to start)", () => {
    expect(autosaveReducer(initialAutosave, { type: "save_start" })).toBe(initialAutosave);
    expect(autosaveReducer(initialAutosave, { type: "save_ok", at: "t" })).toBe(initialAutosave);
    expect(autosaveReducer(initialAutosave, { type: "save_fail" })).toBe(initialAutosave);
  });
  it("every change bumps rev (the editor restarts its debounce on it)", () => {
    expect(run({ type: "change" }, { type: "change" }, { type: "change" }).rev).toBe(3);
    expect(AUTOSAVE_DELAY_MS).toBe(1500);
  });
  it("hasUnsaved drives the leave-page warning: dirty, saving and error warn; idle and saved do not", () => {
    expect(hasUnsaved(initialAutosave)).toBe(false);
    expect(hasUnsaved(run({ type: "change" }))).toBe(true);
    expect(hasUnsaved(run({ type: "change" }, { type: "save_start" }))).toBe(true);
    expect(hasUnsaved(run({ type: "change" }, { type: "save_start" }, { type: "save_fail" }))).toBe(true);
    expect(hasUnsaved(run({ type: "change" }, { type: "save_start" }, { type: "save_ok", at: "t" }))).toBe(false);
  });
  it("status text", () => {
    const time = (iso: string) => iso.slice(11, 16);
    expect(autosaveText(initialAutosave, time)).toMatch(/saved automatically/);
    expect(autosaveText(run({ type: "change" }), time)).toBe("Unsaved changes");
    expect(autosaveText(run({ type: "change" }, { type: "save_start" }), time)).toBe("Saving…");
    expect(autosaveText(run({ type: "change" }, { type: "save_start" }, { type: "save_ok", at: "2031-01-06T08:05:00Z" }), time)).toBe("Saved at 08:05");
    expect(autosaveText(run({ type: "change" }, { type: "save_start" }, { type: "save_fail" }), time)).toBe("Could not save — your answers are still on screen, retry");
  });
});

describe("draft sanitiser", () => {
  it("keeps only the template's keys, trims text, and enforces nothing required", () => {
    const d = draftAnswers(schema, { name: "  Ann ", evil: "x", constructor: "y", agree: true });
    expect(d).toEqual({ name: "Ann", agree: true });
  });
  it("leaves out invalid values instead of failing (bad choice, bad date, over-long text, string 'true' for a checkbox)", () => {
    const d = draftAnswers(schema, { mood: "Terrible", born: "2031-02-30", story: "x".repeat(10001), agree: "true", private: false, name: "ok" });
    expect(d).toEqual({ private: false, name: "ok" });
  });
  it("accepts an empty draft and non-object junk", () => {
    expect(draftAnswers(schema, {})).toEqual({});
    expect(draftAnswers(schema, null as unknown as Record<string, unknown>)).toEqual({});
  });
});

describe("consent purposes", () => {
  it("lists the consent fields of a template", () => expect(consentFields(schema).map((f) => f.key)).toEqual(["agree", "share"]));
  it("extracts one purpose per ticked consent checkbox, in template order", () => {
    expect(consentPurposesFrom(schema, { agree: true, share: true })).toEqual(["treatment", "share_referrer"]);
    expect(consentPurposesFrom(schema, { agree: true, share: false })).toEqual(["treatment"]);
    expect(consentPurposesFrom(schema, { agree: "true", private: true })).toEqual([]);
    expect(consentPurposesFrom(schema, {})).toEqual([]);
  });
  it("matches what the seeded templates declare", () => {
    const by = (k: string) => TEMPLATES.find((t) => t.key === k)!.schema;
    expect(consentPurposesFrom(by("informed_consent"), { consent_treatment: true, understood: true })).toEqual(["treatment"]);
    expect(consentPurposesFrom(by("registration"), { reason_for_visit: "x" })).toEqual([]);
  });
  it("has wording for every purpose the database accepts", () => {
    expect([...PURPOSE_ORDER]).toEqual([...CONSENT_PURPOSES]);
    for (const p of CONSENT_PURPOSES) {
      expect(isPurpose(p)).toBe(true);
      expect(PURPOSE_INFO[p].label.length, p).toBeGreaterThan(2);
      expect(PURPOSE_INFO[p].covers.length, p).toBeGreaterThan(20);
    }
    expect(isPurpose("marketing")).toBe(false);
    expect(isPurpose(undefined)).toBe(false);
  });
  it("consent views", () => {
    expect(consentView(undefined)).toEqual({ state: "none" });
    expect(consentView({ purpose: "treatment", granted: true, granted_at: "g", withdrawn_at: null, template_version: 2, form_submission_id: "s" })).toEqual({ state: "granted", at: "g", version: 2, submissionId: "s" });
    expect(consentView({ purpose: "treatment", granted: false, granted_at: "g", withdrawn_at: "w", template_version: 2, form_submission_id: "s" })).toMatchObject({ state: "withdrawn", at: "w", grantedAt: "g" });
    expect(consentView({ purpose: "treatment", granted: false, granted_at: null, withdrawn_at: null, template_version: null, form_submission_id: null })).toEqual({ state: "none" });
  });
});

describe("withdrawal copy", () => {
  it("says the practice is told, keeps the record, and warns that treatment consent affects care", () => {
    const t = withdrawalCopy("treatment");
    expect(t.title).toContain("Treatment");
    expect(t.lines.join(" ")).toMatch(/practice will be notified/);
    expect(t.lines.join(" ")).toMatch(/may affect your care/);
    expect(t.lines.join(" ")).toMatch(/stays on record/);
  });
  it("each purpose has its own consequence line", () => {
    const seen = new Set(CONSENT_PURPOSES.map((p) => withdrawalCopy(p).lines[1]));
    expect(seen.size).toBe(CONSENT_PURPOSES.length);
    expect(withdrawalCopy("share_insurer").lines[1]).toMatch(/pay your account yourself/);
  });
});

describe("access and notices", () => {
  const g = (permissions: unknown, valid_from = "2030-01-01", valid_to: string | null = null) => ({ permissions, valid_from, valid_to });
  it("guardian forms permission mirrors can_access_forms", () => {
    expect(guardianMayUseForms(g({ forms: true }), "2031-01-06")).toBe(true);
    expect(guardianMayUseForms(g({ forms: "true" }), "2031-01-06")).toBe(true);
    expect(guardianMayUseForms(g({ forms: false, book: true }), "2031-01-06")).toBe(false);
    expect(guardianMayUseForms(g({}), "2031-01-06")).toBe(false);
    expect(guardianMayUseForms(g(null), "2031-01-06")).toBe(false);
    expect(guardianMayUseForms(g({ forms: true }, "2032-01-01"), "2031-01-06")).toBe(false);
    expect(guardianMayUseForms(g({ forms: true }, "2030-01-01", "2030-12-31"), "2031-01-06")).toBe(false);
    expect(guardianMayUseForms(g({ forms: true }, "2030-01-01", "2031-01-06"), "2031-01-06")).toBe(true);
  });
  it("latestPerKey keeps the newest version of each template", () => {
    const l = latestPerKey([{ key: "a", version: 1 }, { key: "a", version: 3 }, { key: "b", version: 2 }, { key: "a", version: 2 }]);
    expect(l.sort((x, y) => x.key.localeCompare(y.key))).toEqual([{ key: "a", version: 3 }, { key: "b", version: 2 }]);
  });
  it("templateTitle falls back to the key", () => {
    expect(templateTitle({ key: "x", schema: { title: " Hello " } })).toBe("Hello");
    expect(templateTitle({ key: "share_with_referrer", schema: {} })).toBe("Share with referrer");
    expect(templateTitle({ key: "k", schema: null })).toBe("K");
  });
  it("notices: only known codes render", () => {
    expect(formNotice("submitted")).toMatch(/submitted/);
    expect(formNotice("withdrawn")).toMatch(/withdrawn/);
    expect(formNotice("constructor")).toBeUndefined();
    expect(formNotice("<script>")).toBeUndefined();
    expect(formNotice(undefined)).toBeUndefined();
  });
});

describe("restricted flag", () => {
  it("only the health history is restricted; the schema check accepts a boolean and rejects anything else", () => {
    expect(TEMPLATES.filter((t) => t.schema.restricted).map((t) => t.key)).toEqual(["medical_history"]);
    expect(checkSchema({ restricted: true, fields: [{ key: "a", label: "A", type: "text" }] })).toEqual([]);
    expect(checkSchema({ restricted: "yes", fields: [{ key: "a", label: "A", type: "text" }] })).toEqual(["restricted must be true or false"]);
  });
});
