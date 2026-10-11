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

/** Status as icon + text (colour is only reinforcement). `label` overrides the default wording, e.g. a patient-facing phrase. */
export function StatusChip({ status, label, className }: { status: string; label?: string; className?: string }) {
  const m = statusMeta(status);
  return (
    <span className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium leading-snug", TONE[m.tone], className)}>
      <Icon name={m.icon} />
      <span>{label ?? m.label}</span>
    </span>
  );
}
