import Link from "next/link";
import { PRESETS, PRESET_LABEL, rangeText, type Period } from "@/lib/reports/periods";
import { reportHref } from "@/lib/reports/links";
import type { ReportTab } from "@/lib/reports/keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { cx } from "@/lib/cx";

const PILL = "inline-flex min-h-11 items-center rounded-xl px-4 py-2 font-medium no-underline";

/** Report type: ordinary links (the page re-renders for the chosen type); the current one is marked with aria-current and a bottom rule, not colour alone. */
export function ReportTabs({ tabs, current, period }: { tabs: { key: ReportTab; label: string }[]; current: ReportTab; period: Period }) {
  return (
    <nav aria-label="Report type" className="mb-6 border-b border-line">
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
        {tabs.map((t) => (
          <li key={t.key}>
            <Link href={reportHref(t.key, period)} aria-current={t.key === current ? "page" : undefined}
                  className={cx(PILL, "-mb-px rounded-b-none border-b-2", t.key === current ? "border-sage-700 text-ink" : "border-transparent text-blue-700 hover:bg-blue-100")}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The period: preset links, and a custom from/to form (native date inputs, checked again on the server). */
export function PeriodControls({ report, period }: { report: ReportTab; period: Period }) {
  return (
    <section aria-label="Choose the period" className="mb-8">
      <p className="mb-2 font-medium">Period: <span className="font-normal">{PRESET_LABEL[period.preset]}, {rangeText(period)}</span></p>
      <ul className="m-0 mb-4 flex list-none flex-wrap gap-2 p-0">
        {PRESETS.filter((p) => p !== "custom").map((p) => (
          <li key={p}>
            <Link href={reportHref(report, period, p)} aria-current={period.preset === p ? "true" : undefined}
                  className={cx(PILL, "border", period.preset === p ? "border-sage-700 bg-sage-100 text-sage-900" : "border-line-strong bg-surface text-ink hover:bg-sunk")}>
              {PRESET_LABEL[p]}
            </Link>
          </li>
        ))}
      </ul>
      <form method="get" action="/app/reports" aria-label="Custom dates" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="report" value={report} />
        <input type="hidden" name="preset" value="custom" />
        <div className="min-w-40 [&>div]:mb-0"><Input id="from" label="From (date)" type="date" defaultValue={period.from} required /></div>
        <div className="min-w-40 [&>div]:mb-0"><Input id="to" label="To (date)" type="date" defaultValue={period.to} required /></div>
        <Button type="submit" variant="secondary">Show these dates</Button>
      </form>
    </section>
  );
}
