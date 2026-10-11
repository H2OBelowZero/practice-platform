import { cx } from "@/lib/cx";
import { statusMeta, type Tone } from "@/lib/status";
import { Icon } from "./icon";

const TONE: Record<Tone, string> = {
  neutral: "bg-grey-tint text-grey-ink",
  info: "bg-blue-100 text-blue-800",
  success: "bg-sage-100 text-sage-900",
  warning: "bg-warn-tint text-warn-ink",
  danger: "bg-danger-tint text-danger-strong",
};

/**
 * Wrapping is allowed (no nowrap, max-w-full, icon pinned to the first line) so a long `label` override such as
 * "Request received: the practice will confirm" (43 chars, wider than the 343px content area of a 375px phone at text-sm)
 * wraps instead of overflowing. The built-in labels are all <= 12 characters (about 130px with icon and padding), checked in
 * tests/unit/status.test.ts, so they stay on one line at 375px.
 * Status as icon + text (colour is only reinforcement). `label` overrides the default wording, e.g. a patient-facing phrase. */
export function StatusChip({ status, label, className }: { status: string; label?: string; className?: string }) {
  const m = statusMeta(status);
  return (
    <span className={cx("inline-flex max-w-full items-start gap-1.5 rounded-2xl px-3 py-1 text-sm font-medium leading-snug", TONE[m.tone], className)}>
      <Icon name={m.icon} className="mt-0.5" />
      <span>{label ?? m.label}</span>
    </span>
  );
}
