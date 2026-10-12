import { z } from "zod";
import { addDays, isRealDate, sastDate, sastMidnight } from "@/lib/time";

export const PRIORITIES = [{ value: "high", label: "High" }, { value: "normal", label: "Normal" }, { value: "low", label: "Low" }] as const;
export const PRIORITY_FILTERS = [{ value: "", label: "Any priority" }, ...PRIORITIES] as const;
export const DUE_FILTERS = [
  { value: "", label: "Any due date" }, { value: "overdue", label: "Overdue" }, { value: "now", label: "Due today or overdue" }, { value: "today", label: "Due today" },
  { value: "week", label: "Due in the next 7 days (including today)" }, { value: "none", label: "No due date" },
] as const;
export type TaskDueFilter = "overdue" | "now" | "today" | "week" | "none";

export const parseTaskStatus = (s: string | undefined): "open" | "done" => (s === "done" ? "done" : "open");
export const parseTaskPriority = (s: string | undefined): string => (PRIORITIES.some((p) => p.value === s) ? (s as string) : "");
export const parseTaskDue = (s: string | undefined): TaskDueFilter | "" => (DUE_FILTERS.some((d) => d.value === s && s !== "") ? (s as TaskDueFilter) : "");

export const PRIORITY_RANK: Record<string, number> = { high: 0, normal: 1, low: 2 };
export const PRIORITY_LABEL: Record<string, string> = { high: "High priority", normal: "Normal priority", low: "Low priority" };

/** Due-date bounds (UTC instants) for a "due" filter; every date is a SAST calendar day. `week` = the 7 days today .. today + 6 (inclusive). */
export function dueBounds(f: TaskDueFilter, today: string): { gte?: string; lt?: string; isNull?: true } {
  const start = sastMidnight(today);
  if (f === "overdue") return { lt: start };
  if (f === "now") return { lt: sastMidnight(addDays(today, 1)) };
  if (f === "today") return { gte: start, lt: sastMidnight(addDays(today, 1)) };
  if (f === "week") return { gte: start, lt: sastMidnight(addDays(today, 7)) };
  return { isNull: true };
}

export const isTaskOverdue = (t: { status: string; due_at: string | null }, today: string): boolean => t.status === "open" && !!t.due_at && sastDate(t.due_at) < today;
export const isTaskDueToday = (t: { status: string; due_at: string | null }, today: string): boolean => t.status === "open" && !!t.due_at && sastDate(t.due_at) === today;

/** Sort order for a short list: earliest due day first, undated last, then high before normal before low. Stable for equal keys. */
export function sortTasks<T extends { due_at: string | null; priority: string }>(rows: T[]): T[] {
  return rows.map((r, i) => ({ r, i })).sort((a, b) => {
    const da = a.r.due_at ? sastDate(a.r.due_at) : "9999-12-31", db = b.r.due_at ? sastDate(b.r.due_at) : "9999-12-31";
    return da.localeCompare(db) || (PRIORITY_RANK[a.r.priority] ?? 1) - (PRIORITY_RANK[b.r.priority] ?? 1) || a.i - b.i;
  }).map((x) => x.r);
}

/** A return address after an action: only a path under /app/tasks (with a plain query string) is honoured, anything else is the tasks page. */
export function safeTasksBack(v: unknown): string {
  return typeof v === "string" && /^\/app\/tasks(\?[A-Za-z0-9_=&%.\-+:]{0,200})?$/.test(v) ? v : "/app/tasks";
}

// ---- input -------------------------------------------------------------------------------------------------------------------
const blank = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const dueDate = z.preprocess(blank, z.string().refine((d) => isRealDate(d) && d >= "2000-01-01" && d <= "2100-12-31", "Enter a real due date.").optional());
const priority = z.enum(["low", "normal", "high"], { error: "Choose a priority." });

export const taskId = z.uuid();
export const createTaskSchema = z.object({
  title: z.string({ error: "Give the task a title." }).trim().min(1, "Give the task a title.").max(200, "Keep the title under 200 characters."),
  due: dueDate,
  priority,
  patientId: z.preprocess(blank, z.uuid("Choose the patient again.").optional()),
});
export const updateTaskSchema = z.object({ due: dueDate, priority });

/** Due date (YYYY-MM-DD, SAST) to the stored instant: the start of that SAST day. */
export const dueInstant = (date: string | undefined): string | null => (date ? sastMidnight(date) : null);

// Success messages shown after a redirect (?notice=code). Only codes in this map are ever rendered.
const NOTICES = {
  created: "The task has been added.", updated: "The task has been updated.", unchanged: "Nothing was changed.",
  done: "The task is marked done.", reopened: "The task is open again.",
} as const;
export const taskNotice = (code: string | undefined): string | undefined => (code !== undefined && Object.hasOwn(NOTICES, code) ? NOTICES[code as keyof typeof NOTICES] : undefined);
