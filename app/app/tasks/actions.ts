"use server";

import { redirect } from "next/navigation";
import { audit } from "@/lib/audit";
import { safely } from "@/lib/appointments/followups";
import type { ActionState, Values } from "@/lib/appointments/types";
import { requireRole } from "@/lib/auth/session";
import { createTaskSchema, dueInstant, safeTasksBack, taskId, updateTaskSchema } from "@/lib/tasks/list";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";

// Staff task actions (psychologist and admin). Every one calls requireRole itself (R26), validates with Zod and writes through the signed-in user's own
// client, so RLS decides (a risk_flag task is visible to the psychologist only: for the admin it simply does not exist here).
// AUDIT: the task id and, for an update, the field NAMES that changed. Never a title, a date or a patient's name.
const STAFF = ["psychologist", "admin"] as const;
const NOT_FOUND = { error: "We could not find that task. It may have been removed." };
const SAVE_FAILED = { error: "We could not save that. Please try again." };
const firstIssue = (e: { issues: { message: string; path: PropertyKey[] }[] }): NonNullable<ActionState> => ({ error: e.issues[0]?.message ?? "Please check the details and try again.", field: String(e.issues[0]?.path[0] ?? "") || undefined });

/** Create a task a person typed in (source 'manual'), optionally about one patient. A manual task is never a risk_flag or any other system task. */
export async function createTask(values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const v = createTaskSchema.safeParse(values);
  if (!v.success) return firstIssue(v.error);
  const sb = await supabaseServer();
  if (v.data.patientId) {
    const { data } = await sb.from("patients").select("id").eq("id", v.data.patientId).maybeSingle();
    if (!data) return { error: "We could not find that patient. Choose the patient again.", field: "patientId" };
  }
  const { data, error } = await sb.from("tasks").insert({
    title: v.data.title, due_at: dueInstant(v.data.due), priority: v.data.priority, patient_id: v.data.patientId ?? null, source: "manual",
  }).select("id").single();
  if (error || !data) return SAVE_FAILED;
  await safely("task.create", () => audit("task.create", "tasks", data.id as string, { fields: ["title", "priority", ...(v.data.due ? ["due_at"] : []), ...(v.data.patientId ? ["patient_id"] : [])] }));
  return redirect("/app/tasks?notice=created");
}

/** Change a task's due date and/or priority. Only the fields that really changed are written and audited (by name). */
export async function updateTask(rawId: unknown, rawBack: unknown, values: Values): Promise<ActionState> {
  await requireRole([...STAFF]);
  const id = taskId.safeParse(rawId);
  if (!id.success) return NOT_FOUND;
  const v = updateTaskSchema.safeParse(values);
  if (!v.success) return firstIssue(v.error);
  const sb = await supabaseServer();
  const { data: cur } = await sb.from("tasks").select("id, due_at, priority").eq("id", id.data).maybeSingle();
  if (!cur) return NOT_FOUND;

  const patch: Record<string, string | null> = {};
  const fields: string[] = [];
  const due = dueInstant(v.data.due);
  if ((cur.due_at ? sastDate(cur.due_at as string) : null) !== (v.data.due ?? null)) { patch.due_at = due; fields.push("due_at"); }
  if (cur.priority !== v.data.priority) { patch.priority = v.data.priority; fields.push("priority"); }
  if (fields.length) {
    const { data, error } = await sb.from("tasks").update(patch).eq("id", id.data).select("id");
    if (error || !data?.length) return SAVE_FAILED;
    await safely("task.update", () => audit("task.update", "tasks", id.data, { fields }));
  }
  return redirect(withNotice(safeTasksBack(rawBack), fields.length ? "updated" : "unchanged"));
}

/** Mark a task done (audited task.complete) or open it again (task.reopen). Repeating it is harmless. */
export async function setTaskStatus(rawId: unknown, status: unknown, rawBack: unknown): Promise<ActionState> {
  await requireRole([...STAFF]);
  const id = taskId.safeParse(rawId);
  if (!id.success || (status !== "done" && status !== "open")) return NOT_FOUND;
  const sb = await supabaseServer();
  const { data: cur } = await sb.from("tasks").select("id, status").eq("id", id.data).maybeSingle();
  if (!cur) return NOT_FOUND;
  if (cur.status !== status) {
    const { data, error } = await sb.from("tasks").update({ status }).eq("id", id.data).select("id");
    if (error || !data?.length) return SAVE_FAILED;
    await safely(status === "done" ? "task.complete" : "task.reopen", () => audit(status === "done" ? "task.complete" : "task.reopen", "tasks", id.data));
  }
  return redirect(withNotice(safeTasksBack(rawBack), status === "done" ? "done" : "reopened"));
}

/** `back` already passed safeTasksBack, so it is /app/tasks with an optional plain query; add (or replace) the notice. */
function withNotice(back: string, notice: string): string {
  const [path, query = ""] = back.split("?");
  const p = new URLSearchParams(query);
  p.set("notice", notice);
  return `${path}?${p.toString()}`;
}
