import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "@/components/ui/icon";

const TILE = "lift flex h-full gap-4 rounded-card border border-line bg-surface p-5 text-ink no-underline shadow-card hover:text-ink";

/** The pale gold disc that holds a tile's icon. */
const Badge = ({ icon, warn }: { icon: IconName; warn?: boolean }) => (
  <span aria-hidden="true" className={cx("flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg ring-1",
    warn ? "bg-surface text-warn-ink ring-warn-ink/30" : "bg-gold-100 text-gold-700 ring-gold-200")}><Icon name={icon} /></span>
);

/** The "couldn't load" line for a tile or section: quiet, plain words, no codes. */
export function Unavailable({ what }: { what: string }) {
  return (
    <p className="flex items-start gap-2 text-ink-muted" role="status">
      <Icon name="info" className="mt-1" /><span>We couldn&apos;t load {what} just now. Refresh the page to try again.</span>
    </p>
  );
}

type TileProps = { icon: IconName; label: string; value: string; note?: ReactNode; href: string; attention?: boolean; unavailable?: boolean };

/** A tile that is one link to the page where the work is done. `attention` adds an icon and the words "Needs attention" (never colour alone). */
export function Tile({ icon, label, value, note, href, attention, unavailable }: TileProps) {
  return (
    <Link href={href} className={cx(TILE, attention && "border-warn-ink/40 bg-warn-tint hover:border-warn-ink/60")}>
      <Badge icon={icon} warn={attention} />
      <span className="min-w-0">
      <span className="block text-sm font-medium text-ink-muted">{label}<span className="sr-only">: </span></span>
      <span className="mt-1 block font-display text-[1.75rem] font-semibold leading-tight tracking-tight tabular-nums">
        {unavailable ? <><span aria-hidden="true">{value}</span><span className="sr-only">not available</span></> : value}
      </span>
      {attention && <span className="mt-1 flex items-center gap-1.5 text-sm font-semibold text-warn-ink"><Icon name="alert" />Needs attention</span>}
      <span className="mt-1 block text-sm text-ink-muted">{unavailable ? "We couldn't load this just now." : note}</span>
      </span>
    </Link>
  );
}

/** The "Awaiting action" tile has several parts, each its own link, so it is a panel with a list rather than one link. */
export function AwaitingTile({ value, rows, partial, hint }: { value: string; rows: { label: string; count: number | null; href: string }[]; partial: boolean; hint?: string }) {
  return (
    <div className="flex h-full gap-4 rounded-card border border-line bg-surface p-5 shadow-card">
      <Badge icon="tasks" />
      <div className="min-w-0 flex-1">
      <p className="text-sm font-medium text-ink-muted">Awaiting action</p>
      <p className="mt-1 font-display text-[1.75rem] font-semibold leading-tight tracking-tight tabular-nums">{value}</p>
      <ul className="m-0 mt-2 grid list-none gap-1 p-0 text-sm">
        {rows.map((r) => (
          <li key={r.label} className="flex justify-between gap-3">
            <Link href={r.href}>{r.label}</Link>
            <span className="font-medium tabular-nums">{r.count === null ? "–" : r.count}</span>
          </li>
        ))}
      </ul>
      {partial && <p className="mt-2 text-sm text-ink-muted">Some counts could not be loaded just now.</p>}
      {hint && <p className="mt-2 text-sm text-ink-muted">{hint}</p>}
      </div>
    </div>
  );
}
