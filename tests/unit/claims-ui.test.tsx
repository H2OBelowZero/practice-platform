import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Icd10Picker } from "@/app/app/claims/icd10-picker";
import { KeepForm } from "@/app/app/billing/keep-form";

const chosen = [{ code: "F41.1", description: "Generalised anxiety disorder" }];

describe("ICD-10 picker (server-rendered markup)", () => {
  it("offers a labelled search, the chosen codes with their descriptions and one hidden field for the form; matches only appear after a search", () => {
    const html = renderToStaticMarkup(<Icd10Picker initial={chosen} />);
    expect(html).toMatch(/<legend[^>]*>Diagnosis codes \(ICD-10\)/);
    expect(html).toContain("Clinical information");
    expect(html).toMatch(/<label[^>]*>Search the code list<\/label>/);
    expect(html).not.toContain("type=\"checkbox\""); // nothing is listed until the person searches (the list is searched on the server)
    expect(html).toContain("Selected (1)");
    expect(html).toContain("Generalised anxiety disorder");
    expect(html).toContain("aria-label=\"Remove F41.1\"");
    expect(html).toMatch(/<input type="hidden" name="icd10" value="F41\.1"\/>/);
    expect(html).toMatch(/role="status"/); // the live line that says Searching / N codes found
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
  });
  it("for the admin it is disabled with the explanation, has no search, no Remove buttons, and still carries the current codes unchanged", () => {
    const html = renderToStaticMarkup(<Icd10Picker initial={chosen} disabled />);
    expect(html).toContain("Diagnosis codes are added by the practitioner.");
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).not.toContain("Search the code list");
    expect(html).not.toContain("Remove F41.1");
    // the hidden field sits outside the disabled fieldset, or the browser would not send it
    expect(html.slice(html.indexOf("</fieldset>"))).toMatch(/<input type="hidden" name="icd10" value="F41\.1"\/>/);
  });
  it("shows an error as text with an icon and links it to the group", () => {
    const html = renderToStaticMarkup(<Icd10Picker initial={[]} error="Choose diagnosis codes from the list (at most 12)." />);
    expect(html).toContain("Error: ");
    expect(html).toContain("Choose diagnosis codes from the list");
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).toMatch(/aria-describedby="[^"]*-error"/);
    expect(html).toContain("No codes selected.");
  });
});

describe("KeepForm", () => {
  it("does not use the browser's own validation: the server (Zod) messages, shown next to the field, are the source of truth", () => {
    const html = renderToStaticMarkup(<KeepForm action={async () => null} args={[]} submitLabel="Save"><input name="x" required /></KeepForm>);
    expect(html).toMatch(/<form[^>]*\bnovalidate=""/i);
    expect(html).toContain("required"); // the control still says it is required (aria / assistive technology)
  });
});
