import { cx } from "@/lib/cx";
import { PRIORITY_LABEL } from "@/lib/tasks/list";
import { isTaskDueToday, isTaskOverdue } from "@/lib/tasks/list";
import { sastDate, sastDayShort } from "@/lib/time";
import { Icon } from "@/components/ui/icon";
import { StatusChip } from "@/components/ui/status-chip";

/** Priority as icon + text (never colour alone). */
export function PriorityChip({ priority }: { priority: string }) {
  const high = priority === "high";
  return (
    <span className={cx("inline-flex items-start gap-1.5 rounded-2xl px-3 py-1 text-sm font-medium leading-snug", high ? "bg-warn-tint text-warn-ink" : "bg-grey-tint text-grey-ink")}>
      <Icon name={high ? "alert" : "minus"} className="mt-0.5" />
      <span>{PRIORITY_LABEL[priority] ?? "Normal priority"}</span>
    </span>
  );
}

/** "Overdue" chip (icon + text) with the date, "Due today", the date, or "No due date". */
export function DueText({ task, today }: { task: { status: string; due_at: string | null }; today: string }) {
  if (!task.due_at) return <span className="text-ink-muted">No due date</span>;
  const day = sastDate(task.due_at);
  const text = sastDayShort(day, true);
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {isTaskOverdue(task, today) && <StatusChip status="overdue" />}
      <span>{isTaskDueToday(task, today) ? `Due today (${text})` : `Due ${text}`}</span>
    </span>
  );
}
