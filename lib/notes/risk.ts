export const RISK_LEVELS = ["none", "low", "moderate", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export type Risk = { level?: RiskLevel; notes?: string };

export const RISK_LABEL: Record<RiskLevel, string> = { none: "No risk identified", low: "Low", moderate: "Moderate", high: "High" };

/**
 * The staff task a risk flag raises: only for moderate and high, always the same wording. A flag prompts the clinician's own professional
 * assessment; it never states or implies a diagnosis, and the risk notes are never copied into the task (the title is fixed text).
 */
export function riskTask(risk: Risk): { title: string; priority: "high" } | null {
  if (risk.level !== "moderate" && risk.level !== "high") return null;
  return { title: "Risk flagged: professional assessment and follow-up required", priority: "high" as const };
}

/** `tasks.source` for a note's risk task: one per note (a unique index in the database), so a re-save, a second tab or a rise in level finds it instead of adding another. An id only. */
export const riskSource = (noteId: string): string => `risk_flag:${noteId}`;
