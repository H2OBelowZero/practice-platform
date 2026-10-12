/**
 * Autosave state machine for the form editor (pure, so it can be tested without a browser).
 *   idle --change--> dirty --save_start--> saving --save_ok--> saved --change--> dirty
 *                                            |  \--save_fail--> error --change--> dirty, or retry: save_start --> saving
 *                                            \--change while saving: remembered, and the state is dirty again once the save lands
 * `rev` counts changes: the editor restarts its 1.5 s debounce whenever it moves.
 */
export type AutosavePhase = "idle" | "dirty" | "saving" | "saved" | "error";
export type AutosaveState = { phase: AutosavePhase; rev: number; again: boolean; savedAt?: string };
export type AutosaveAction = { type: "change" } | { type: "save_start" } | { type: "save_ok"; at: string } | { type: "save_fail" };

export const AUTOSAVE_DELAY_MS = 1500;
export const initialAutosave: AutosaveState = { phase: "idle", rev: 0, again: false };

export function autosaveReducer(s: AutosaveState, a: AutosaveAction): AutosaveState {
  switch (a.type) {
    case "change":
      return s.phase === "saving" ? { ...s, rev: s.rev + 1, again: true } : { ...s, phase: "dirty", rev: s.rev + 1 };
    case "save_start":
      return s.phase === "dirty" || s.phase === "error" ? { ...s, phase: "saving", again: false } : s;
    case "save_ok":
      return s.phase === "saving" ? { ...s, phase: s.again ? "dirty" : "saved", again: false, savedAt: a.at } : s;
    case "save_fail":
      return s.phase === "saving" ? { ...s, phase: s.again ? "dirty" : "error", again: false } : s;
  }
}

/** True while there is something on screen that is not safely stored (drives the leave-the-page warning). */
export const hasUnsaved = (s: AutosaveState): boolean => s.phase === "dirty" || s.phase === "saving" || s.phase === "error";

/** Text for the polite status line. `time` formats the ISO instant of the last save (the editor passes SAST HH:MM). */
export function autosaveText(s: AutosaveState, time: (iso: string) => string): string {
  switch (s.phase) {
    case "idle": return "Your answers are saved automatically as you type.";
    case "dirty": return "Unsaved changes";
    case "saving": return "Saving…";
    case "saved": return s.savedAt ? `Saved at ${time(s.savedAt)}` : "Saved";
    case "error": return "Could not save — your answers are still on screen, retry";
  }
}
