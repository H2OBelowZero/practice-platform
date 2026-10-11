import { cx } from "@/lib/cx";

// Tiny inline icon set (16x16, 2px stroke). Decorative by default (aria-hidden): the text next to an icon always carries the meaning.
const PATHS = {
  check: "M3 8.5l3.2 3.2L13 4.8",
  clock: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 4.8V8l2.3 1.5",
  x: "M4 4l8 8M12 4l-8 8",
  alert: "M8 2.5l6 10.5H2zM8 6.8v3M8 11.6v.1",
  info: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 7.2v4M8 4.9v.1",
  pencil: "M3 13l.7-3L10.5 3.2l2.3 2.3L6 12.3z",
  half: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM8 2v12",
  send: "M2 8l12-5-4 11-2.5-4.5z",
  ban: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM3.8 12.2l8.4-8.4",
  archive: "M2.5 4h11v3h-11zM3.5 7v6h9V7M6.5 9.5h3",
  minus: "M4 8h8",
  home: "M2.5 8L8 3l5.5 5M4 7v6h8V7",
  calendar: "M3 4.5h10v9H3zM3 7.5h10M5.5 2.5v3M10.5 2.5v3",
  users: "M6 7.5a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6zM2 13c0-2.2 1.8-3.7 4-3.7s4 1.5 4 3.7M11 3.3a2.3 2.3 0 0 1 0 4.2M12 9.5c1.3.5 2 1.7 2 3.5",
  tasks: "M3 4l1.2 1.2L6.2 3M8 4.5h5M3 9l1.2 1.2L6.2 8M8 9.5h5M3.2 13.5h.1M8 13.5h5",
  more: "M3.5 8h.01M8 8h.01M12.5 8h.01",
  card: "M2 4.5h12v8H2zM2 7.5h12",
  chart: "M3 13V3M3 13h10M6 11V8M9 11V5M12 11V7",
  gear: "M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M12.4 3.6l-1.2 1.2M4.8 11.2l-1.2 1.2",
  shield: "M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z",
  doc: "M4 2h5l3 3v9H4zM9 2v3h3",
  logout: "M6.5 3H3v10h3.5M10 5.5L12.5 8 10 10.5M12.5 8H6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className, label }: { name: IconName; className?: string; label?: string }) {
  return (
    <svg viewBox="0 0 16 16" width="1.1em" height="1.1em" fill="none" stroke="currentColor" strokeWidth={1.8}
         strokeLinecap="round" strokeLinejoin="round" className={cx("inline-block shrink-0 align-[-0.15em]", className)}
         aria-hidden={label ? undefined : true} role={label ? "img" : undefined} aria-label={label} focusable="false">
      <path d={PATHS[name]} />
    </svg>
  );
}
