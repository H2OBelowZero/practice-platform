import { cx } from "@/lib/cx";
import { Icon } from "./icon";

/** Crisis disclaimer. Pass `practices.crisis_text` where the page can read it; getCrisisText() supplies the fallback. */
export function EmergencyNotice({ text, className }: { text: string; className?: string }) {
  return (
    <aside aria-label="In an emergency" className={cx("flex gap-3 rounded-xl border border-line bg-sunk p-4 text-sm", className)}>
      <Icon name="info" className="mt-0.5 text-blue-700" />
      <p><strong className="font-semibold">In an emergency: </strong>{text}</p>
    </aside>
  );
}
