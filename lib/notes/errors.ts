/** Plain messages for note actions. Never built from a database message that could carry text, and never from note content. */
export const NOTE_ERROR = {
  generic: "We could not do that. Please try again.",
  invalid: "That request was not valid. Please refresh the page and try again.",
  missing: "We could not find that note.",
  closed: "This note has been signed, so it can no longer be edited. Add an addendum to correct it.",
  empty: "Write something in the note before signing it.",
  notAuthor: "Only the author of a note can sign it.",
  notSigned: "An addendum can only be added to a signed note.",
  forbidden: "You do not have permission to do that.",
  task: "The follow-up task for the risk flag could not be created. Nothing was signed; please try again.",
  appointment: "That appointment cannot be linked: choose an attended or confirmed appointment of this patient.",
  template: "That note template is not available.",
} as const;

/** Map a database error (sign_note, add_addendum, notes_guard, RLS) to a message; unknown errors get the generic one. */
export function noteErrorText(message: string | undefined | null): string {
  const m = message ?? "";
  if (/not_author/.test(m)) return NOTE_ERROR.notAuthor;
  if (/note_not_signed/.test(m)) return NOTE_ERROR.notSigned;
  if (/note not draftable|immutable|invalid_state_transition/.test(m)) return NOTE_ERROR.closed;
  if (/forbidden|row-level security|permission denied/.test(m)) return NOTE_ERROR.forbidden;
  return NOTE_ERROR.generic;
}

/** The status line text for the note editor (the pure reducer in lib/forms/autosave.ts supplies the phase). */
export function noteSaveText(phase: "idle" | "dirty" | "saving" | "saved" | "error" | "conflict", savedAt: string | undefined, time: (iso: string) => string): string {
  switch (phase) {
    case "idle": return "Your note is saved automatically as you type.";
    case "dirty": return "Unsaved changes";
    case "saving": return "Saving…";
    case "saved": return savedAt ? `Saved at ${time(savedAt)}` : "Saved";
    case "error": return "Could not save. Your text is still on screen; retry.";
    case "conflict": return "This note is no longer a draft. Reload to see it.";
  }
}
