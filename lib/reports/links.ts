import { hrefWith } from "@/lib/patients/list";
import type { ExportKey, ReportTab } from "./keys";
import type { Period } from "./periods";

/** The page URL for a tab and period: a preset is just its name; custom dates carry from and to. */
export const reportHref = (report: ReportTab, p: Pick<Period, "preset" | "from" | "to">, preset: string = p.preset): string =>
  hrefWith("/app/reports", { report, preset, from: preset === "custom" ? p.from : undefined, to: preset === "custom" ? p.to : undefined });

/** The CSV download URL for one report over the period on screen (always the resolved dates, so the file matches what is shown). */
export const exportHref = (key: ExportKey, p: Pick<Period, "from" | "to">): string => hrefWith("/app/reports/export", { report: key, from: p.from, to: p.to });
