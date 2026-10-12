import { describe, it, expect } from "vitest";
import { groupFilter, groupLabel, isPayfastUnreconciled, parseTaskGroup, payfastDetails, taskExplanation, taskGroup, TASK_GROUPS } from "@/lib/tasks/groups";
import { taskLink } from "@/lib/tasks/links";
import {
  createTaskSchema, dueBounds, isTaskDueToday, isTaskOverdue, parseTaskDue, parseTaskPriority, parseTaskStatus, safeTasksBack, sortTasks, updateTaskSchema,
} from "@/lib/tasks/list";
import { sastMidnight } from "@/lib/time";

const I = "11111111-2222-4333-8444-555555555555", P = "9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d", T = "3f6b2c1e-5a7d-4e2b-9c1a-0d4f6a8b2c3d";

describe("taskGroup", () => {
  it("classifies every source the database creates", () => {
    expect(taskGroup(`risk_flag:${I}`)).toBe("clinical");
    expect(taskGroup("late_cancel_fee")).toBe("bookings");
    expect(taskGroup("payfast_unreconciled:1089250")).toBe("billing");
    expect(taskGroup(`overdue_invoice:${I}`)).toBe("billing");
    expect(taskGroup("claim_rejected")).toBe("billing");
    expect(taskGroup("consent_withdrawn")).toBe("forms");
    expect(taskGroup("duplicate_patient")).toBe("system");
    expect(taskGroup("outbox_failed:42")).toBe("system");
  });
  it("manual tasks have a null, empty or 'manual' source; an unknown source is system, never hidden", () => {
    expect(taskGroup(null)).toBe("manual");
    expect(taskGroup(undefined)).toBe("manual");
    expect(taskGroup("")).toBe("manual");
    expect(taskGroup("manual")).toBe("manual");
    expect(taskGroup("something_new")).toBe("system");
  });
  it("every group has a label and a database filter, and 'any' has no filter", () => {
    for (const g of TASK_GROUPS) { expect(groupLabel(g.value)).toBe(g.label); expect(groupFilter(g.value)).toBeTruthy(); }
    expect(groupFilter("")).toBeNull();
    expect(parseTaskGroup("billing")).toBe("billing");
    expect(parseTaskGroup("nonsense")).toBe("");
    expect(parseTaskGroup(undefined)).toBe("");
  });
  it("filters quote the prefixes (the colon must not be read as PostgREST syntax) and use the * wildcard", () => {
    expect(groupFilter("clinical")).toBe('source.like."risk_flag:*"');
    expect(groupFilter("billing")).toContain('source.like."payfast_unreconciled:*"');
    expect(groupFilter("billing")).toContain('source.like."overdue_invoice:*"');
    expect(groupFilter("billing")).not.toMatch(/%/);
    expect(groupFilter("manual")).toBe("source.is.null,source.eq.manual");
  });
});

describe("payfast tasks", () => {
  it("recognises them by source and reads the 0014 meta", () => {
    expect(isPayfastUnreconciled("payfast_unreconciled:5")).toBe(true);
    expect(isPayfastUnreconciled("overdue_invoice:5")).toBe(false);
    expect(isPayfastUnreconciled(null)).toBe(false);
    const d = payfastDetails({ invoice_id: I, pf_payment_id: "5", reason: "invoice_not_payable", amount_cents: 95000, outstanding_cents: 0 });
    expect(d).toEqual({ amountCents: 95000, outstandingCents: 0, reason: expect.stringContaining("no longer accepts payments") });
    expect(payfastDetails({ amount_cents: 1, outstanding_cents: 2, reason: "free text <script>" })?.reason).toBe("The payment could not be matched to an invoice.");
  });
  it("returns null for meta that does not carry the amounts", () => {
    expect(payfastDetails(null)).toBeNull();
    expect(payfastDetails({})).toBeNull();
    expect(payfastDetails({ amount_cents: "95000", outstanding_cents: 0 })).toBeNull();
    expect(payfastDetails({ amount_cents: -1, outstanding_cents: 0 })).toBeNull();
    expect(payfastDetails({ amount_cents: 1.5, outstanding_cents: 0 })).toBeNull();
  });
});

describe("taskExplanation and taskLink for the system sources", () => {
  it("outbox_failed has an explanation and no link", () => {
    expect(taskExplanation("outbox_failed:7")).toMatch(/could not be delivered/);
    expect(taskLink({ id: T, source: "outbox_failed:7", meta: { template: "reminder_24h", channel: "email" } })).toBeNull();
  });
  it("other sources", () => {
    expect(taskExplanation("duplicate_patient")).toMatch(/same person/);
    expect(taskExplanation("risk_flag:" + I)).not.toMatch(/\bnote text\b/);
    expect(taskExplanation(null)).toBeNull();
    expect(taskExplanation("late_cancel_fee")).toBeNull();
  });
  it("the links the tasks page relies on", () => {
    expect(taskLink({ id: T, source: `overdue_invoice:${I}`, patient_id: P })?.href).toBe(`/app/billing/${I}`);
    expect(taskLink({ id: T, source: "duplicate_patient", patient_id: P })?.href).toBe(`/app/patients/${P}`);
    expect(taskLink({ id: T, source: "consent_withdrawn", patient_id: P })?.href).toBe(`/app/patients/${P}?tab=forms`);
    expect(taskLink({ id: T, source: "payfast_unreconciled:9", patient_id: P, meta: { invoice_id: I } })?.href).toBe(`/app/billing/${I}`);
    expect(taskLink({ id: T, source: "manual", patient_id: P })).toBeNull();
  });
});

describe("list helpers", () => {
  it("parses filters, falling back to a safe default", () => {
    expect(parseTaskStatus("done")).toBe("done");
    expect(parseTaskStatus("whatever")).toBe("open");
    expect(parseTaskStatus(undefined)).toBe("open");
    expect(parseTaskPriority("high")).toBe("high");
    expect(parseTaskPriority("urgent")).toBe("");
    expect(parseTaskDue("overdue")).toBe("overdue");
    expect(parseTaskDue("")).toBe("");
    expect(parseTaskDue("eventually")).toBe("");
  });
  it("due bounds are SAST days", () => {
    const today = "2031-03-10";
    expect(dueBounds("overdue", today)).toEqual({ lt: sastMidnight("2031-03-10") });
    expect(dueBounds("today", today)).toEqual({ gte: sastMidnight("2031-03-10"), lt: sastMidnight("2031-03-11") });
    expect(dueBounds("week", today)).toEqual({ gte: sastMidnight("2031-03-10"), lt: sastMidnight("2031-03-18") });
    expect(dueBounds("none", today)).toEqual({ isNull: true });
    expect(sastMidnight("2031-03-10")).toBe("2031-03-09T22:00:00.000Z");
  });
  it("overdue and due-today use the SAST day, only for open tasks", () => {
    const due = sastMidnight("2031-03-10");
    expect(isTaskOverdue({ status: "open", due_at: due }, "2031-03-10")).toBe(false);
    expect(isTaskOverdue({ status: "open", due_at: due }, "2031-03-11")).toBe(true);
    expect(isTaskOverdue({ status: "done", due_at: due }, "2031-03-11")).toBe(false);
    expect(isTaskOverdue({ status: "open", due_at: null }, "2031-03-11")).toBe(false);
    expect(isTaskDueToday({ status: "open", due_at: due }, "2031-03-10")).toBe(true);
    expect(isTaskDueToday({ status: "open", due_at: due }, "2031-03-09")).toBe(false);
  });
  it("sorts by due day, undated last, then priority", () => {
    const rows = [
      { n: "undated-high", due_at: null, priority: "high" },
      { n: "later-high", due_at: sastMidnight("2031-03-12"), priority: "high" },
      { n: "soon-low", due_at: sastMidnight("2031-03-10"), priority: "low" },
      { n: "soon-high", due_at: sastMidnight("2031-03-10"), priority: "high" },
      { n: "undated-low", due_at: null, priority: "low" },
    ];
    expect(sortTasks(rows).map((r) => r.n)).toEqual(["soon-high", "soon-low", "later-high", "undated-high", "undated-low"]);
  });
  it("only returns to a path under /app/tasks", () => {
    expect(safeTasksBack("/app/tasks?status=done&page=2")).toBe("/app/tasks?status=done&page=2");
    expect(safeTasksBack("/app/tasks")).toBe("/app/tasks");
    for (const bad of ["https://evil.example", "//evil.example", "/app/patients", "/app/tasks/../../x", "/app/tasks?x=<script>", "javascript:alert(1)", undefined, 5, "/app/tasksx"])
      expect(safeTasksBack(bad)).toBe("/app/tasks");
  });
});

describe("task input", () => {
  it("accepts a title with an optional due date, priority and patient", () => {
    expect(createTaskSchema.safeParse({ title: "  Call back  ", due: "", priority: "normal", patientId: "" }).data).toEqual({ title: "Call back", due: undefined, priority: "normal", patientId: undefined });
    expect(createTaskSchema.safeParse({ title: "x", due: "2031-03-10", priority: "high", patientId: P }).success).toBe(true);
  });
  it("rejects an empty or long title, a bad date, a bad priority and a bad patient id", () => {
    const base = { title: "x", due: "", priority: "normal", patientId: "" };
    expect(createTaskSchema.safeParse({ ...base, title: "   " }).success).toBe(false);
    expect(createTaskSchema.safeParse({ ...base, title: "a".repeat(201) }).success).toBe(false);
    expect(createTaskSchema.safeParse({ ...base, title: "a".repeat(200) }).success).toBe(true);
    expect(createTaskSchema.safeParse({ ...base, due: "2031-02-30" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ ...base, due: "tomorrow" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ ...base, priority: "urgent" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ ...base, patientId: "not-a-uuid" }).success).toBe(false);
    expect(createTaskSchema.safeParse({ priority: "normal" }).success).toBe(false);
  });
  it("an update takes a due date (or none) and a priority only", () => {
    expect(updateTaskSchema.safeParse({ due: "", priority: "low" }).data).toEqual({ due: undefined, priority: "low" });
    expect(updateTaskSchema.safeParse({ due: "2031-13-01", priority: "low" }).success).toBe(false);
  });
});
