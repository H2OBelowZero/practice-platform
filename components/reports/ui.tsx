import type { ReactNode } from "react";
import { barWidth } from "@/lib/reports/format";
import { AnchorButton } from "@/components/ui/button";
import { cx } from "@/lib/cx";

/** A small proportional bar inside a table cell. Decorative: the figure beside it carries the meaning, so it is hidden from assistive technology. */
export function Bar({ value, max, tone = "sage" }: { value: number; max: number; tone?: "sage" | "blue" }) {
  const w = barWidth(value, max);
  return (
    <span aria-hidden="true" className="mt-1 block h-1.5 w-full min-w-16 rounded-full bg-sunk">
      <span className={cx("block h-full rounded-full", tone === "blue" ? "bg-blue-500" : "bg-sage-500")} style={{ width: `${w}%` }} />
    </span>
  );
}

export type Col<T> = { header: string; num?: boolean; cell: (row: T) => ReactNode; total?: ReactNode };

/**
 * An accessible report table: a caption, column headers with scope, the first column as row headers, numbers right-aligned in tabular figures.
 * The wrapper is a focusable named region so a wide table can be scrolled with the keyboard. `total` on any column adds a totals row.
 */
export function DataTable<T>({ caption, cols, rows, rowKey, totalLabel = "Total" }: { caption: string; cols: Col<T>[]; rows: T[]; rowKey: (r: T) => string; totalLabel?: string }) {
  const hasTotal = cols.some((c) => c.total !== undefined);
  return (
    <div role="region" aria-label={caption} tabIndex={0} className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-sunk text-sm text-ink-muted">
          <tr>{cols.map((c, i) => <th key={i} scope="col" className={cx("px-4 py-3 font-medium", c.num && "text-right")}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} className="border-t border-line align-top">
              {cols.map((c, i) => i === 0
                ? <th key={i} scope="row" className="px-4 py-3 font-medium">{c.cell(r)}</th>
                : <td key={i} className={cx("px-4 py-3", c.num && "text-right tabular-nums")}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
        {hasTotal && (
          <tfoot>
            <tr className="border-t-2 border-line-strong bg-sunk font-semibold">
              {cols.map((c, i) => i === 0
                ? <th key={i} scope="row" className="px-4 py-3">{totalLabel}</th>
                : <td key={i} className={cx("px-4 py-3", c.num && "text-right tabular-nums")}>{c.total}</td>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** A figure with a label, for the headline numbers above a table. */
export function Figure({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded-xl bg-sunk p-4">
      <p className="text-sm text-ink-muted">{label}</p>
      <p className="mt-1 font-serif text-2xl tabular-nums">{value}</p>
      {note && <p className="mt-1 text-sm text-ink-muted">{note}</p>}
    </div>
  );
}

/**
 * One report: heading, optional CSV download (a plain anchor, never a next/link: see AnchorButton), then the content or a quiet note when its query failed
 * or there is nothing to show, then the plain-language definition.
 */
export function ReportSection({ id, title, intro, exportHref, exportLabel, state, emptyText, definition, children }: {
  id: string; title: string; intro?: ReactNode; exportHref?: string; exportLabel?: string;
  state: "ok" | "empty" | "failed"; emptyText?: string; definition: string; children?: ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-h`} className="mb-10">
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
        <div className="max-w-2xl">
          <h2 id={`${id}-h`} className="text-xl">{title}</h2>
          {intro && <p className="mt-1 text-ink-muted">{intro}</p>}
        </div>
        {exportHref && state !== "failed" && <AnchorButton variant="secondary" href={exportHref} aria-label={exportLabel ?? `Download ${title} as CSV`}>Download CSV</AnchorButton>}
      </div>
      {state === "failed" && <p className="mb-3 text-ink-muted">We couldn&apos;t load this report just now. Refresh the page to try again.</p>}
      {state === "empty" && <p className="mb-3 text-ink-muted">{emptyText ?? "Nothing to show for this period."}</p>}
      {state === "ok" && children}
      <p className="mt-3 max-w-3xl text-sm text-ink-muted"><span className="font-medium text-ink">What this means. </span>{definition}</p>
    </section>
  );
}
