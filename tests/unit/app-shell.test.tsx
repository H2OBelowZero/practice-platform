import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("@/lib/practice", () => ({ getCrisisText: async () => "crisis text" }));
vi.mock("@/app/globals.css", () => ({})); // global-error.tsx imports the stylesheet; Vite would run PostCSS on it

import ErrorPage from "@/app/error";
import GlobalError from "@/app/global-error";
import robots from "@/app/robots";
import manifest from "@/app/manifest";

const boom = Object.assign(new Error("duplicate key value violates unique constraint patients_email_key (jane@example.com)"), { digest: "1234567890" });

describe("error pages never leak details", () => {
  for (const [name, el] of [["error.tsx", <ErrorPage key="a" error={boom} reset={() => {}} />], ["global-error.tsx", <GlobalError key="b" error={boom} reset={() => {}} />]] as const) {
    it(`${name} shows no message or stack, only the reference`, () => {
      const html = renderToStaticMarkup(el);
      expect(html).not.toContain(boom.message);
      expect(html).not.toMatch(/duplicate key|jane@example|patients_email_key|at [\w.<>]+ \(/);
      expect(html).toContain("1234567890");
      expect(html).toContain("Try again");
    });
  }
  it("error.tsx without a digest shows no reference line", () => {
    expect(renderToStaticMarkup(<ErrorPage error={new Error("x")} reset={() => {}} />)).not.toContain("Reference");
  });
  it("not-found is friendly and links home and to login", async () => {
    const { default: NotFound } = await import("@/app/not-found");
    const shell = NotFound(); // <PublicShell>: an async server component, so render it by calling it
    const html = renderToStaticMarkup(await shell.type(shell.props));
    expect(html).toContain("Page not found");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/login"');
  });
});

describe("robots and manifest", () => {
  it("keeps crawlers out of authenticated areas but allows / and /book", () => {
    const r = robots().rules as { allow: string[]; disallow: string[] }[];
    expect(r[0].allow).toEqual(["/", "/book"]);
    for (const p of ["/app", "/portal", "/api", "/auth", "/login", "/mfa", "/recover"]) expect(r[0].disallow).toContain(p);
  });
  it("manifest is standalone with token colours and an svg icon", () => {
    const m = manifest();
    expect(m).toMatchObject({ name: "Practice Platform", display: "standalone", background_color: "#f7f3ea", theme_color: "#173a2f" });
    expect(m.icons?.[0].src).toBe("/icon.svg");
  });
});
