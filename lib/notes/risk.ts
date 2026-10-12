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

/** `tasks.source` for a note's risk task: one per note and level, so a re-save (or a second tab) finds it instead of adding another. Ids and a level only. */
export const riskSource = (noteId: string, level: "moderate" | "high"): string => `risk_flag:${noteId}:${level}`;
