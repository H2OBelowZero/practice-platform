import Link from "next/link";
import { assignLanes, blockPosition, minuteOfDay, overlapsDay } from "@/lib/calendar/grid";
import { sastDayShort, sastTime, sastDateLabel } from "@/lib/time";
import { cx } from "@/lib/cx";
import { StatusChip } from "@/components/ui/status-chip";
import type { CalAppt } from "./types";

const HOUR_PX = 84; // a 50-minute session is 70px tall: room for name, time and status

/**
 * Day/week time grid (CSS grid, SAST). Each day is a column with its appointments positioned by start and end time;
 * overlapping appointments share the width. Semantics: one heading per day, a list of links per day, in time order.
 * Shown from the md breakpoint up; phones get the agenda list instead (same data, see CalendarPage).
 */
export function TimeGrid({ days, appts, today, startHour, endHour }: { days: string[]; appts: CalAppt[]; today: string; startHour: number; endHour: number }) {
  const gridStart = startHour * 60, gridEnd = endHour * 60;
  const height = (endHour - startHour) * HOUR_PX;
  const cols = { gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` };
  const hours = Array.from({ length: endHour - startHour }, (_, i) => startHour + i);

  return (
    <div className="hidden overflow-x-auto rounded-card border border-line bg-surface md:block">
      <div className={days.length > 1 ? "min-w-[46rem]" : ""}>
        <div className="grid border-b border-line" style={cols}>
          <div />
          {days.map((d) => (
            <h3 key={d} id={`day-${d}`} aria-current={d === today ? "date" : undefined}
                className={cx("border-l border-line px-2 py-2 text-center font-sans text-sm font-semibold", d === today ? "bg-sage-100 text-sage-900" : "text-ink")}>
              <span className="sr-only">{sastDateLabel(d)}</span>
              <span aria-hidden="true">{sastDayShort(d)}</span>{d === today && <span className="font-normal"> (today)</span>}
            </h3>
          ))}
        </div>
        <div className="grid" style={cols}>
          <div aria-hidden="true" className="relative" style={{ height }}>
            {hours.map((h, i) => (
              <span key={h} className="absolute right-2 text-xs tabular-nums text-ink-muted" style={{ top: i * HOUR_PX + (i === 0 ? 2 : -9) }}>{String(h).padStart(2, "0")}:00</span>
            ))}
          </div>
          {days.map((d) => {
            const blocks = assignLanes(overlapsDay(appts, d).map((a) => ({ a, startMin: minuteOfDay(a.starts_at, d), endMin: minuteOfDay(a.ends_at, d) })));
            return (
              <div key={d} className="relative border-l border-line" style={{ height }}>
                {hours.map((h, i) => <div key={h} aria-hidden="true" className="absolute inset-x-0 border-t border-line" style={{ top: i * HOUR_PX }} />)}
                <ul aria-labelledby={`day-${d}`} className="absolute inset-0 m-0 list-none p-0">
                  {blocks.map(({ a, startMin, endMin, lane, lanes }) => {
                    const pos = blockPosition(startMin, endMin, gridStart, gridEnd);
                    return (
                      <li key={a.id} className="absolute p-0.5" style={{ top: `${pos.top}%`, height: `${pos.height}%`, left: `${(lane / lanes) * 100}%`, width: `${100 / lanes}%` }}>
                        <Link href={`/app/calendar/${a.id}`}
                              className={cx("flex h-full flex-col items-start gap-0.5 overflow-hidden rounded-lg border border-line-strong border-l-4 border-l-sage-700 bg-sage-100 px-1.5 py-1 text-xs leading-tight text-ink no-underline hover:bg-sage-200 hover:text-ink",
                                a.status === "cancelled" && "opacity-75")}>
                          <span className="w-full truncate font-semibold">{a.patientName}</span>
                          <span className="w-full truncate text-ink-muted">{sastTime(a.starts_at)} to {sastTime(a.ends_at)} · {a.typeName}</span>
                          <StatusChip status={a.status} className="px-2! py-0! text-xs!" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
