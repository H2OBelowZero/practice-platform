import type { IconName } from "@/components/ui/icon";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export type StatusMeta = { label: string; tone: Tone; icon: IconName };

/**
 * Every status value the database can hold (appointments, invoices, claims, forms, notes, tasks, patients, outbox, payments)
 * plus the derived "overdue". Status is never colour-only: every entry has an icon and a text label.
 * tests/unit/status.test.ts checks this map against the check constraints in supabase/migrations, so a new DB status
 * without an entry here fails the build.
 */
export const STATUS = {
  // appointments (tentative = a request the practice has not yet confirmed; shown to people as "Requested")
  requested: { label: "Requested", tone: "info", icon: "clock" },
  tentative: { label: "Requested", tone: "info", icon: "clock" },
  confirmed: { label: "Confirmed", tone: "success", icon: "check" },
  attended: { label: "Attended", tone: "success", icon: "check" },
  no_show: { label: "No-show", tone: "warning", icon: "alert" },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "x" },
  // invoices, claims, payments
  draft: { label: "Draft", tone: "neutral", icon: "pencil" },
  issued: { label: "Issued", tone: "info", icon: "send" },
  part_paid: { label: "Part paid", tone: "warning", icon: "half" },
  paid: { label: "Paid", tone: "success", icon: "check" },
  overdue: { label: "Overdue", tone: "danger", icon: "alert" },
  void: { label: "Void", tone: "neutral", icon: "ban" },
  submitted: { label: "Submitted", tone: "info", icon: "send" },
  accepted: { label: "Accepted", tone: "success", icon: "check" },
  rejected: { label: "Rejected", tone: "danger", icon: "x" },
  succeeded: { label: "Succeeded", tone: "success", icon: "check" },
  failed: { label: "Failed", tone: "danger", icon: "alert" },
  // medical aid membership dates
  current: { label: "Current", tone: "success", icon: "check" },
  expired: { label: "Expired", tone: "neutral", icon: "clock" },
  upcoming: { label: "Not started", tone: "info", icon: "clock" },
  // forms, notes, tasks
  returned: { label: "Returned", tone: "warning", icon: "alert" },
  signed: { label: "Signed", tone: "success", icon: "check" },
  amended: { label: "Amended", tone: "info", icon: "pencil" },
  open: { label: "Open", tone: "info", icon: "clock" },
  done: { label: "Done", tone: "success", icon: "check" },
  // patients
  prospect: { label: "Prospect", tone: "info", icon: "info" },
  active: { label: "Active", tone: "success", icon: "check" },
  archived: { label: "Archived", tone: "neutral", icon: "archive" },
  // notification outbox
  pending: { label: "Pending", tone: "neutral", icon: "clock" },
  sent: { label: "Sent", tone: "success", icon: "send" },
} as const satisfies Record<string, StatusMeta>;

export type StatusKey = keyof typeof STATUS;

const humanise = (s: string) => { const t = s.replace(/_/g, " ").trim(); return t ? t[0].toUpperCase() + t.slice(1) : "Unknown"; };

/** Meta for a status value; an unknown value still renders as an icon + readable text (never blank, never colour only). */
export function statusMeta(status: string): StatusMeta {
  return (STATUS as Record<string, StatusMeta>)[status] ?? { label: humanise(status), tone: "neutral", icon: "info" };
}
