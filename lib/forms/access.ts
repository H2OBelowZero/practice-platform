/** Same test as can_access_forms() in 0004: the guardianship is current and carries permissions.forms. (The database decides; this only decides what to offer.) */
export function guardianMayUseForms(g: { permissions: unknown; valid_from: string; valid_to: string | null }, today: string): boolean {
  const forms = (g.permissions as { forms?: unknown } | null)?.forms;
  return (forms === true || forms === "true") && g.valid_from <= today && (g.valid_to === null || g.valid_to >= today);
}

/** Display title of a template: its own title, else its key made readable. */
export const templateTitle = (t: { key: string; schema: { title?: string } | null }): string =>
  t.schema?.title?.trim() || t.key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The newest version of each template key (input: active templates). */
export function latestPerKey<T extends { key: string; version: number }>(templates: T[]): T[] {
  const best = new Map<string, T>();
  for (const t of templates) { const b = best.get(t.key); if (!b || t.version > b.version) best.set(t.key, t); }
  return [...best.values()];
}
