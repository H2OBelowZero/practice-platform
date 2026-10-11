import { describe, it, expect } from "vitest";
import { checkSchema, validateAnswers, type FormSchema } from "@/lib/forms/validate";

const schema: FormSchema = { fields: [
  { key: "name", label: "Name", type: "text", required: true },
  { key: "agree", label: "I consent", type: "checkbox", required: true, consentPurpose: "treatment" },
] };

describe("validateAnswers", () => {
  it("flags missing required fields", () => {
    const r = validateAnswers(schema, { name: "" });
    expect(r.ok).toBe(false);
    expect(r.errors.name).toBeTruthy();
    expect(r.errors.agree).toBeTruthy();
  });
  it("passes complete answers", () => expect(validateAnswers(schema, { name: "A", agree: true }).ok).toBe(true));
  it("treats whitespace-only text as missing", () => expect(validateAnswers(schema, { name: "   ", agree: true }).errors.name).toBeTruthy());
  it("trims text in the cleaned answers", () => expect(validateAnswers(schema, { name: "  Ann ", agree: true }).clean.name).toBe("Ann"));

  const sel: FormSchema = { fields: [{ key: "c", label: "Choice", type: "select", options: ["a", "b"] }] };
  it("select: value must be one of the options (also when optional)", () => {
    expect(validateAnswers(sel, { c: "a" }).ok).toBe(true);
    expect(validateAnswers(sel, { c: "z" }).errors.c).toMatch(/invalid choice/);
    expect(validateAnswers(sel, { c: 1 }).errors.c).toBeTruthy();
    expect(validateAnswers(sel, {}).ok).toBe(true);
    expect(validateAnswers({ fields: [{ ...sel.fields[0], required: true }] }, {}).ok).toBe(false);
  });

  const dt: FormSchema = { fields: [{ key: "d", label: "Date", type: "date" }] };
  it("date: must be a real YYYY-MM-DD date", () => {
    expect(validateAnswers(dt, { d: "2030-02-28" }).ok).toBe(true);
    for (const bad of ["2030-02-30", "2030-13-01", "28/02/2030", "2030-2-3", "yesterday", 20300228]) expect(validateAnswers(dt, { d: bad }).ok, String(bad)).toBe(false);
  });

  it("text is limited to 2000 characters and textarea to 10000", () => {
    const t: FormSchema = { fields: [{ key: "t", label: "T", type: "text" }, { key: "a", label: "A", type: "textarea" }] };
    expect(validateAnswers(t, { t: "x".repeat(2000), a: "x".repeat(10000) }).ok).toBe(true);
    const r = validateAnswers(t, { t: "x".repeat(2001), a: "x".repeat(10001) });
    expect(r.errors.t).toMatch(/2000/);
    expect(r.errors.a).toMatch(/10000/);
  });

  it("text answers must be strings", () => {
    const t: FormSchema = { fields: [{ key: "t", label: "T", type: "text" }] };
    for (const bad of [5, true, {}, ["a"]]) expect(validateAnswers(t, { t: bad }).ok).toBe(false);
  });

  it("checkbox: required means true; false and missing fail", () => {
    const c: FormSchema = { fields: [{ key: "c", label: "C", type: "checkbox", required: true }] };
    expect(validateAnswers(c, { c: true }).ok).toBe(true);
    expect(validateAnswers(c, { c: false }).ok).toBe(false);
    expect(validateAnswers(c, {}).ok).toBe(false);
  });

  it("consent fields must be real booleans, whether required or not", () => {
    for (const required of [true, false]) {
      const c: FormSchema = { fields: [{ key: "c", label: "C", type: "checkbox", required, consentPurpose: "telehealth" }] };
      for (const bad of ["true", "on", 1, "yes"]) expect(validateAnswers(c, { c: bad }).ok, `${required}/${String(bad)}`).toBe(false);
    }
    const optional: FormSchema = { fields: [{ key: "c", label: "C", type: "checkbox", consentPurpose: "share_referrer" }] };
    expect(validateAnswers(optional, { c: false }).ok).toBe(true);
    expect(validateAnswers(optional, { c: false }).clean.c).toBe(false);
  });

  it("ignores unknown keys and does not return them", () => {
    const r = validateAnswers(schema, { name: "A", agree: true, admin: true, extra: "x" });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.clean).sort()).toEqual(["agree", "name"]);
  });

  it("inherited keys are not answers", () => {
    const s: FormSchema = { fields: [{ key: "constructor", label: "C", type: "text", required: true }] };
    expect(validateAnswers(s, {}).ok).toBe(false);
    expect(validateAnswers(s, JSON.parse('{"__proto__": {"constructor": "x"}}')).ok).toBe(false);
  });

  it("returns one message per failing field", () => {
    const r = validateAnswers({ fields: [
      { key: "a", label: "A", type: "text", required: true }, { key: "b", label: "B", type: "date", required: true }, { key: "c", label: "C", type: "text" },
    ] }, { b: "nope", c: "fine" });
    expect(Object.keys(r.errors).sort()).toEqual(["a", "b"]);
  });
});

describe("checkSchema", () => {
  const ok = { fields: [{ key: "a_1", label: "A", type: "text" }] };
  it("accepts a good schema", () => expect(checkSchema(ok)).toEqual([]));
  it.each([
    ["not an object", null], ["no fields", { fields: [] }], ["fields not array", { fields: {} }],
    ["bad key", { fields: [{ key: "Bad Key", label: "A", type: "text" }] }],
    ["duplicate key", { fields: [{ key: "a", label: "A", type: "text" }, { key: "a", label: "B", type: "text" }] }],
    ["empty label", { fields: [{ key: "a", label: " ", type: "text" }] }],
    ["unknown type", { fields: [{ key: "a", label: "A", type: "radio" }] }],
    ["select without options", { fields: [{ key: "a", label: "A", type: "select" }] }],
    ["select with one option", { fields: [{ key: "a", label: "A", type: "select", options: ["x"] }] }],
    ["options on a text field", { fields: [{ key: "a", label: "A", type: "text", options: ["x", "y"] }] }],
    ["consent on a text field", { fields: [{ key: "a", label: "A", type: "text", consentPurpose: "treatment" }] }],
    ["unknown purpose", { fields: [{ key: "a", label: "A", type: "checkbox", consentPurpose: "marketing" }] }],
    ["purpose used twice", { fields: [{ key: "a", label: "A", type: "checkbox", consentPurpose: "treatment" }, { key: "b", label: "B", type: "checkbox", consentPurpose: "treatment" }] }],
  ])("rejects: %s", (_n, s) => expect(checkSchema(s).length).toBeGreaterThan(0));
});
