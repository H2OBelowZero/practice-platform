import type { HTMLAttributes } from "react";
import { cx } from "@/lib/cx";

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("rounded-card border border-line bg-surface p-5 shadow-card sm:p-6", className)} {...rest} />;
}

/** Quieter inset panel (no shadow) for grouping inside a Card or on the canvas. */
export function Panel({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("rounded-xl bg-sunk p-4", className)} {...rest} />;
}
