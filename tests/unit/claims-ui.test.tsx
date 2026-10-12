import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Icd10Picker } from "@/app/app/claims/icd10-picker";

const codes = [
  { code: "F32.9", description: "Depressive episode, unspecified" },
  { code: "F41.1", description: "Generalised anxiety disorder" },
];

describe("ICD-10 picker (server-rendered markup)", () => {
  it("offers a labelled search, one checkbox per code, the chosen codes and one hidden field for the form", () => {
    const html = renderToStaticMarkup(<Icd10Picker codes={codes} initial={["F41.1"]} />);
    expect(html).toMatch(/<legend[^>]*>Diagnosis codes \(ICD-10\)/);
    expect(html).toContain("Clinical information");
    expect(html).toMatch(/<label[^>]*>Search the code list<\/label>/);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
    expect(html).toContain("Selected (1)");
    expect(html).toContain("aria-label=\"Remove F41.1\"");
    expect(html).toMatch(/<input type="hidden" name="icd10" value="F41\.1"\/>/);
    expect(html).not.toMatch(/<fieldset[^>]*disabled/);
  });
  it("for the admin it is disabled with the explanation, has no search, no Remove buttons, and still carries the current codes unchanged", () => {
    const html = renderToStaticMarkup(<Icd10Picker codes={codes} initial={["F32.9"]} disabled />);
    expect(html).toContain("Diagnosis codes are added by the practitioner.");
    expect(html).toMatch(/<fieldset[^>]*disabled/);
    expect(html).not.toContain("Search the code list");
    expect(html).not.toContain("Remove F32.9");
    // the hidden field sits outside the disabled fieldset, or the browser would not send it
    const afterFieldset = html.slice(html.indexOf("</fieldset>"));
    expect(afterFieldset).toMatch(/<input type="hidden" name="icd10" value="F32\.9"\/>/);
  });
  it("shows an error as text with an icon and links it to the group", () => {
    const html = renderToStaticMarkup(<Icd10Picker codes={codes} initial={[]} error="Choose diagnosis codes from the list (at most 12)." />);
    expect(html).toContain("Error: ");
    expect(html).toContain("Choose diagnosis codes from the list");
    expect(html).toMatch(/aria-invalid="true"/);
    expect(html).toMatch(/aria-describedby="[^"]*-error"/);
  });
  it("explains an empty list instead of showing a blank box", () => {
    expect(renderToStaticMarkup(<Icd10Picker codes={[]} initial={[]} />)).toContain("The code list is empty.");
  });
});
