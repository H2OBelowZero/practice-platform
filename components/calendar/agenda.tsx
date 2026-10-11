import Link from "next/link";
import { sastDateLabel, sastTime } from "@/lib/time";
import { cx } from "@/lib/cx";
import { Notice } from "@/components/ui/notice";
import { StatusChip } from "@/components/ui/status-chip";
import type { CalAppt } from "./types";

/**
 * Agenda: appointments grouped by day, as a plain list. The default on phones; also selectable on any screen, and used under
 * the day/week views on phones. Days without appointments are left out unless `keepEmpty`.
 */
export function Agenda({ groups, today, keepEmpty, className }: { groups: { date: string; items: CalAppt[] }[]; today: string; keepEmpty?: boolean; className?: string }) {
  const shown = keepEmpty ? groups : groups.filter((g) => g.items.length > 0);
  if (shown.every((g) => g.items.length === 0)) {
    return <div className={className}><Notice tone="info">No appointments in this period{keepEmpty ? "" : ". Try another date or clear the filters"}.</Notice></div>;
  }
  return (
    <ol className={cx("m-0 grid list-none gap-6 p-0", className)}>
      {shown.map((g) => (
        <li key={g.date}>
          <section aria-labelledby={`agenda-${g.date}`}>
            <h3 id={`agenda-${g.date}`} className="mb-2 font-sans text-base font-semibold">{sastDateLabel(g.date)}{g.date === today && " (today)"}</h3>
            {g.items.length === 0 ? <p className="text-ink-muted">Nothing booked.</p> : (
              <ul className="m-0 grid list-none gap-2 p-0">
                {g.items.map((a) => (
                  <li key={a.id}>
                    <Link href={`/app/calendar/${a.id}`}
                          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-surface p-4 text-ink no-underline hover:bg-sage-100 hover:text-ink">
                      <span>
                        <span className="block font-semibold tabular-nums">{sastTime(a.starts_at)} to {sastTime(a.ends_at)}</span>
                        <span className="block">{a.patientName}</span>
                        <span className="block text-sm text-ink-muted">{a.typeName}</span>
                      </span>
                      <StatusChip status={a.status} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </li>
      ))}
    </ol>
  );
}
