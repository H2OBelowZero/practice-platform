import { forwardRef, type ReactNode } from "react";
import { cx } from "@/lib/cx";
import { Icon, type IconName } from "./icon";

export type NoticeTone = "info" | "success" | "warning" | "error";

const TONE: Record<NoticeTone, { box: string; icon: IconName; word: string }> = {
  info: { box: "border-blue-500 bg-blue-100 text-blue-800", icon: "info", word: "Note" },
  success: { box: "border-sage-500 bg-sage-100 text-sage-900", icon: "check", word: "Done" },
  warning: { box: "border-warn-ink bg-warn-tint text-warn-ink", icon: "alert", word: "Please note" },
  error: { box: "border-danger bg-danger-tint text-danger-strong", icon: "alert", word: "Error" },
};

type Props = { tone?: NoticeTone; title?: string; children: ReactNode; className?: string; id?: string; focusable?: boolean };

/**
 * Message box: icon + a text prefix (read by screen readers and visible), colour only reinforces.
 * Errors/warnings use role="alert"; info/success use role="status". `focusable` lets a form move focus to an error summary.
 */
export const Notice = forwardRef<HTMLDivElement, Props>(function Notice({ tone = "info", title, children, className, id, focusable }, ref) {
  const t = TONE[tone];
  return (
    <div ref={ref} id={id} tabIndex={focusable ? -1 : undefined} role={focusable ? undefined : tone === "error" || tone === "warning" ? "alert" : "status"}
         className={cx("mb-5 flex gap-3 rounded-xl border-l-4 p-4", t.box, className)}>
      <Icon name={t.icon} className="mt-1" />
      <div>
        <p className="font-semibold">{title ?? t.word}</p>
        <div className="[&>p+p]:mt-2">{children}</div>
      </div>
    </div>
  );
});
