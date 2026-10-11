import Link from "next/link";
import { calendarHref, stepDate, type CalView } from "@/lib/calendar/range";
import { sastDate } from "@/lib/time";
import { cx } from "@/lib/cx";
import { Button, LinkButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";

const VIEWS: { view: CalView; label: string }[] = [{ view: "day", label: "Day" }, { view: "week", label: "Week" }, { view: "agenda", label: "Agenda" }];
const UNIT: Record<CalView, string> = { day: "day", week: "week", agenda: "fortnight" };

export const STATUS_FILTERS = [
  { value: "", label: "All except cancelled" }, { value: "all", label: "All, including cancelled" },
  { value: "tentative", label: "Requested" }, { value: "confirmed", label: "Confirmed" }, { value: "attended", label: "Attended" },
  { value: "no_show", label: "No-show" }, { value: "cancelled", label: "Cancelled" },
];

/** Previous / today / next, the view switch, and the status and name filters. All plain links and a GET form: no JavaScript needed. */
export function CalendarToolbar({ view, date, status, q, label }: { view: CalView; date: string; status: string; q: string; label: string }) {
  const href = (v: CalView, d: string) => calendarHref({ view: v, date: d, status, q });
  const today = sastDate(new Date());
  return (
    <div className="mb-6 grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Change period" className="flex flex-wrap gap-2">
          <LinkButton variant="secondary" href={href(view, stepDate(view, date, -1))} aria-label={`Previous ${UNIT[view]}`}>Previous</LinkButton>
          <LinkButton variant="secondary" href={href(view, today)}>Today</LinkButton>
          <LinkButton variant="secondary" href={href(view, stepDate(view, date, 1))} aria-label={`Next ${UNIT[view]}`}>Next</LinkButton>
        </nav>
        <nav aria-label="Calendar view" className="flex overflow-hidden rounded-xl border border-line-strong">
          {VIEWS.map((v) => (
            <Link key={v.view} href={href(v.view, date)} aria-current={v.view === view ? "page" : undefined}
                  className={cx("inline-flex min-h-11 items-center px-4 font-medium no-underline", v.view === view ? "bg-sage-700 text-white hover:bg-sage-800 hover:text-white" : "bg-surface text-ink hover:bg-sunk hover:text-ink")}>
              {v.label}
            </Link>
          ))}
        </nav>
      </div>
      <h2 aria-live="polite" className="font-sans text-lg font-semibold">{label}</h2>
      <form method="get" action="/app/calendar" role="search" aria-label="Filter appointments" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="view" value={view} />
        <input type="hidden" name="date" value={date} />
        <div className="min-w-48 flex-1 [&>div]:mb-0">
          <Select id="status" label="Status" defaultValue={status}>
            {STATUS_FILTERS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        </div>
        <div className="min-w-48 flex-1 [&>div]:mb-0">
          <Input id="q" label="Patient name" type="search" defaultValue={q} placeholder="Search by name" maxLength={80} />
        </div>
        <Button type="submit" variant="secondary">Apply filters</Button>
        {(status || q) && <LinkButton variant="quiet" href={calendarHref({ view, date })}>Clear filters</LinkButton>}
      </form>
    </div>
  );
}
