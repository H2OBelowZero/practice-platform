import { describe, it, expect } from "vitest";
import { normaliseZaPhone, phoneVariants } from "@/lib/patients/phone";
import { findDuplicates, normaliseName, type ExistingPatient, type PatientIdentity } from "@/lib/patients/duplicates";
import { ageOn, isMinor, patientNo } from "@/lib/patients/age";
import { cleanSearch, patientNumberQuery, wordFilter } from "@/lib/patients/search";
import { adminSchema, createSchema, emergencyContact, fieldErrors, profileSchema } from "@/lib/patients/input";
import { inviteBlock } from "@/lib/patients/invite";
import { hrefWith, pageCount, pageRange, parseListStatus, parsePage } from "@/lib/patients/list";
import { auditActionText, auditDetailText } from "@/lib/patients/audit-view";
import { patientNotice } from "@/lib/patients/notices";

describe("normaliseZaPhone", () => {
  it.each([
    ["082 123 4567", "+27821234567"], ["0821234567", "+27821234567"], ["082-123-4567", "+27821234567"], ["(082) 123 4567", "+27821234567"],
    ["+27 82 123 4567", "+27821234567"], ["+27821234567", "+27821234567"], ["27821234567", "+27821234567"], ["0027821234567", "+27821234567"],
    ["+27 (0) 82 123 4567", "+27821234567"], ["  011 555 0100 ", "+27115550100"],
    ["+44 20 7946 0958", "+442079460958"], ["0044 20 7946 0958", "+442079460958"],
  ])("%s -> %s", (raw, out) => expect(normaliseZaPhone(raw)).toBe(out));
  it.each(["", "   ", "abc", "082 123", "08212345678", "+27 12 345", "+2782123456789", "12345", "+0 123 456 789", "082 123 4567 ext 5"])("rejects %j", (raw) => expect(normaliseZaPhone(raw)).toBeNull());
  it("the stored form is stable (normalising twice changes nothing)", () => expect(normaliseZaPhone(normaliseZaPhone("082 123 4567")!)).toBe("+27821234567"));
  it("lists older spellings for look-ups", () => {
    expect(phoneVariants("+27821234567")).toEqual(["+27821234567", "0821234567", "27821234567"]);
    expect(phoneVariants("+442079460958")).toEqual(["+442079460958"]);
  });
});

const ann: ExistingPatient = { id: "1", patient_number: 1, first_name: "Ann", last_name: "Botha", date_of_birth: "1990-05-01", email: "Ann.Botha@Example.com", phone: "0821234567", status: "active" };
const none: PatientIdentity = { first_name: "Zed", last_name: "Zulu", date_of_birth: null, email: null, phone: null };

describe("findDuplicates", () => {
  const people: ExistingPatient[] = [ann, { ...ann, id: "2", patient_number: 2, first_name: "Bob", last_name: "Dlamini", date_of_birth: "1985-01-01", email: "bob@example.com", phone: "+27835550000", status: "archived" }];
  it("matches by email, ignoring case and spaces", () => {
    const r = findDuplicates({ ...none, email: "  ann.botha@example.COM " }, people);
    expect(r.map((m) => [m.id, m.reasons])).toEqual([["1", ["email"]]]);
  });
  it("matches by phone in any South African spelling", () => {
    for (const phone of ["+27821234567", "082 123 4567", "27821234567"]) expect(findDuplicates({ ...none, phone }, people).map((m) => m.id), phone).toEqual(["1"]);
  });
  it("matches an exact normalised name with the same date of birth", () => {
    const r = findDuplicates({ ...none, first_name: " ANN ", last_name: "botha", date_of_birth: "1990-05-01" }, people);
    expect(r.map((m) => [m.id, m.reasons])).toEqual([["1", ["name_dob"]]]);
  });
  it("name alone, or the same name with another date of birth, is not a match", () => {
    expect(findDuplicates({ ...none, first_name: "Ann", last_name: "Botha" }, people)).toEqual([]);
    expect(findDuplicates({ ...none, first_name: "Ann", last_name: "Botha", date_of_birth: "1991-05-01" }, people)).toEqual([]);
  });
  it("a near name with the same date of birth is not an exact match", () => expect(findDuplicates({ ...none, first_name: "Anne", last_name: "Botha", date_of_birth: "1990-05-01" }, people)).toEqual([]));
  it("collects every reason, includes archived patients, and ignores blank candidate fields", () => {
    const r = findDuplicates({ first_name: "Ann", last_name: "Botha", date_of_birth: "1990-05-01", email: "ann.botha@example.com", phone: "0821234567" }, people);
    expect(r[0].reasons).toEqual(["email", "phone", "name_dob"]);
    expect(findDuplicates({ ...none, email: "", phone: "" }, [{ ...ann, email: "", phone: "" }])).toEqual([]);
    expect(findDuplicates({ ...none, email: "bob@example.com" }, people)[0].status).toBe("archived");
  });
  it("does not match a different person who shares nothing", () => expect(findDuplicates(none, people)).toEqual([]));
  it("normalises names: accents, punctuation, spacing", () => expect(normaliseName("Zoë", " O'Brien-Smith ")).toBe(normaliseName("zoe", "obriensmith")));
});

describe("age", () => {
  it("counts whole years", () => {
    expect(ageOn("2000-06-15", "2030-06-14")).toBe(29);
    expect(ageOn("2000-06-15", "2030-06-15")).toBe(30);
    expect(ageOn("2000-02-29", "2031-02-28")).toBe(30);
    expect(ageOn(null, "2030-01-01")).toBeNull();
  });
  it("a minor is flagged or under 18", () => {
    expect(isMinor({ is_minor: false, date_of_birth: "2015-01-01" }, "2030-01-01")).toBe(true);
    expect(isMinor({ is_minor: false, date_of_birth: "2012-01-02" }, "2030-01-01")).toBe(true);
    expect(isMinor({ is_minor: false, date_of_birth: "2012-01-01" }, "2030-01-01")).toBe(false);
    expect(isMinor({ is_minor: true, date_of_birth: null }, "2030-01-01")).toBe(true);
    expect(isMinor({ is_minor: false, date_of_birth: null }, "2030-01-01")).toBe(false);
  });
  it("formats the patient number", () => { expect(patientNo(12)).toBe("P0012"); expect(patientNo(12345)).toBe("P12345"); });
});

describe("search", () => {
  it("drops characters that mean something to PostgREST and LIKE", () => {
    expect(cleanSearch(`a%b_c*d,e(f)g\\h"i'j.k:l`)).toBe("a b c d e f g h i j k l");
    expect(cleanSearch("  jane   smith ")).toBe("jane smith");
    expect(cleanSearch("x".repeat(100)).length).toBe(60);
  });
  it("a word matches name, email and phone", () => expect(wordFilter("Jane")).toBe("first_name.ilike.%jane%,last_name.ilike.%jane%,email.ilike.%jane%,phone.ilike.%jane%"));
  it("a number word also finds phones without the leading 0 or 27", () => {
    expect(wordFilter("0821234567")).toContain("phone.ilike.%821234567%");
    expect(wordFilter("+27821234567")).toContain("phone.ilike.%821234567%");
    expect(wordFilter("27821234567")).toContain("phone.ilike.%821234567%");
  });
  it("recognises a patient number search", () => {
    expect(patientNumberQuery("P0012")).toBe(12);
    expect(patientNumberQuery("p-12")).toBe(12);
    expect(patientNumberQuery("12")).toBe(12);
    expect(patientNumberQuery("jane")).toBeNull();
    expect(patientNumberQuery("12 jane")).toBeNull();
    expect(patientNumberQuery("1234567890")).toBeNull();
  });
});

const full = { first_name: "Ann", last_name: "Botha", date_of_birth: "", email: "", phone: "", language: "en", comms_email: "on", comms_sms: "", emergency_name: "", emergency_phone: "", emergency_relationship: "", referral_source: "", payer: "self", status: "prospect" };

describe("patient input schemas", () => {
  it("accepts a name only and turns blanks into undefined", () => {
    const r = createSchema.safeParse(full);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toMatchObject({ first_name: "Ann", last_name: "Botha", date_of_birth: undefined, email: undefined, phone: undefined, comms_email: true, comms_sms: false, confirmDuplicate: false });
  });
  it("requires first and last name", () => {
    const e = fieldErrors(createSchema.safeParse({ ...full, first_name: "  ", last_name: "" }).error!);
    expect(e.first_name).toBeTruthy(); expect(e.last_name).toBeTruthy();
  });
  it("normalises phone numbers and lowercases the email", () => {
    const r = profileSchema.parse({ ...full, phone: "082 123 4567", email: " Ann@Example.COM " });
    expect(r.phone).toBe("+27821234567"); expect(r.email).toBe("ann@example.com");
  });
  it("rejects bad phone and email with a message for the field", () => {
    const e = fieldErrors(profileSchema.safeParse({ ...full, phone: "123", email: "nope" }).error!);
    expect(e.phone).toMatch(/phone/i); expect(e.email).toMatch(/email/i);
  });
  it("date of birth must be a real date and not in the future", () => {
    for (const bad of ["2030-02-30", "31/12/1990", "1850-01-01", "2999-01-01"]) expect(profileSchema.safeParse({ ...full, date_of_birth: bad }).success, bad).toBe(false);
    expect(profileSchema.safeParse({ ...full, date_of_birth: "1990-12-31" }).success).toBe(true);
    expect(profileSchema.safeParse({ ...full, date_of_birth: "2999-01-01" }).error!.issues[0].message).toMatch(/future/);
  });
  it("language and payer must be known values", () => {
    expect(profileSchema.safeParse({ ...full, language: "xx" }).success).toBe(false);
    expect(createSchema.safeParse({ ...full, payer: "free" }).success).toBe(false);
  });
  it("create allows prospect or active only", () => {
    expect(createSchema.safeParse({ ...full, status: "active" }).success).toBe(true);
    expect(createSchema.safeParse({ ...full, status: "archived" }).success).toBe(false);
  });
  it("an emergency contact needs a name and a phone once started", () => {
    expect(adminSchema.safeParse(full).success).toBe(true);
    const e = fieldErrors(adminSchema.safeParse({ ...full, emergency_relationship: "Mother" }).error!);
    expect(e.emergency_name).toBeTruthy(); expect(e.emergency_phone).toBeTruthy();
    const ok = adminSchema.parse({ ...full, emergency_name: "Sam", emergency_phone: "083 555 0000", emergency_relationship: "Brother" });
    expect(emergencyContact(ok)).toEqual({ name: "Sam", phone: "+27835550000", relationship: "Brother" });
    expect(emergencyContact(adminSchema.parse(full))).toBeNull();
  });
  it("admin status is optional (archived patients cannot change it there)", () => expect(adminSchema.safeParse({ ...full, status: undefined }).success).toBe(true));
  it("overlong text is refused", () => expect(adminSchema.safeParse({ ...full, referral_source: "x".repeat(201) }).success).toBe(false));
});

describe("inviteBlock", () => {
  const ok = { email: "a@b.co", user_id: null, status: "active", is_minor: false, date_of_birth: "1990-01-01" };
  it("allows an adult with an email, no account, not archived", () => expect(inviteBlock(ok, "2030-01-01")).toBeNull());
  it("explains each refusal", () => {
    expect(inviteBlock({ ...ok, email: null }, "2030-01-01")).toMatch(/email/);
    expect(inviteBlock({ ...ok, user_id: "u" }, "2030-01-01")).toMatch(/already/);
    expect(inviteBlock({ ...ok, status: "archived" }, "2030-01-01")).toMatch(/Restore/);
    expect(inviteBlock({ ...ok, is_minor: true }, "2030-01-01")).toMatch(/guardian/);
    expect(inviteBlock({ ...ok, date_of_birth: "2020-01-01" }, "2030-01-01")).toMatch(/guardian/);
  });
});

describe("list helpers", () => {
  it("pages", () => {
    expect([parsePage(undefined), parsePage("0"), parsePage("-2"), parsePage("1.5"), parsePage("abc"), parsePage("3")]).toEqual([1, 1, 1, 1, 1, 3]);
    expect(pageRange(1)).toEqual({ from: 0, to: 24 }); expect(pageRange(3)).toEqual({ from: 50, to: 74 });
    expect([pageCount(0), pageCount(25), pageCount(26)]).toEqual([1, 1, 2]);
  });
  it("builds urls without empty parameters", () => {
    expect(hrefWith("/app/patients", { q: "", status: undefined, page: undefined })).toBe("/app/patients");
    expect(hrefWith("/app/patients", { q: "a b", page: 2 })).toBe("/app/patients?q=a+b&page=2");
  });
  it("status filter falls back to the default", () => { expect(parseListStatus("archived")).toBe("archived"); expect(parseListStatus("x")).toBe(""); expect(parseListStatus(undefined)).toBe(""); });
});

describe("audit and notices", () => {
  it("describes patient actions and shows unknown codes as they are", () => { expect(auditActionText("patient.update")).toBe("Changed details"); expect(auditActionText("form.submit")).toBe("form.submit"); expect(auditActionText("constructor")).toBe("constructor"); });
  it("summarises detail without nested values", () => {
    expect(auditDetailText({ fields: ["email", "phone"] })).toBe("fields: email, phone");
    expect(auditDetailText({ from: "active", n: 2, nested: { a: 1 } })).toBe("from: active; n: 2");
    expect(auditDetailText(null)).toBe(""); expect(auditDetailText([1])).toBe("");
  });
  it("only known notice codes render", () => { expect(patientNotice("saved")).toBe("Changes saved."); expect(patientNotice("<b>")).toBeUndefined(); expect(patientNotice("constructor")).toBeUndefined(); });
});
