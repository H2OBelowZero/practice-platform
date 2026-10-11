import type { ReactNode } from "react";
import { cx } from "@/lib/cx";

/** Page title block. Exactly one h1 per page; `actions` sit to the right on wide screens and below on phones. */
export function PageHeader({ title, description, actions, className }: { title: string; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <header className={cx("mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="max-w-2xl">
        <h1>{title}</h1>
        {description && <p className="mt-2 text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </header>
  );
}
