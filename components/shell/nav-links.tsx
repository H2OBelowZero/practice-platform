"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@/lib/cx";
import type { NavItem } from "@/lib/nav";
import { Icon } from "@/components/ui/icon";

type Variant = "sidebar" | "bottom" | "top";

const isActive = (path: string, href: string) => (href === "/app" || href === "/portal" ? path === href : path === href || path.startsWith(href + "/"));

/** Navigation links with aria-current on the active one. `sidebar` and `bottom` sit on dark sage; `top` is the portal's desktop bar. */
export function NavLinks({ items, variant, label }: { items: NavItem[]; variant: Variant; label: string }) {
  const path = usePathname();
  return (
    <nav aria-label={label}>
      <ul className={cx(variant === "sidebar" && "flex flex-col gap-1", variant === "bottom" && "grid auto-cols-fr grid-flow-col", variant === "top" && "flex gap-1")}>
        {items.map((it) => {
          const active = isActive(path, it.href);
          return (
            <li key={it.href} className={variant === "bottom" ? "min-w-0" : undefined}>
              <Link href={it.href} aria-current={active ? "page" : undefined}
                    className={cx(
                      "flex items-center no-underline transition-colors duration-150",
                      variant === "sidebar" && "min-h-11 gap-3 rounded-xl px-3 py-2 text-base",
                      variant === "sidebar" && (active ? "bg-sage-800 font-semibold text-white" : "text-sage-100 hover:bg-sage-800 hover:text-white"),
                      variant === "bottom" && "min-h-14 flex-col justify-center gap-0.5 border-t-2 px-1 py-1.5 text-xs",
                      variant === "bottom" && (active ? "border-sage-200 font-semibold text-white" : "border-transparent text-sage-200 hover:text-white"),
                      variant === "top" && "min-h-11 gap-2 rounded-xl px-3.5 py-2 text-base",
                      variant === "top" && (active ? "bg-sage-100 font-semibold text-sage-900" : "text-ink hover:bg-sunk hover:text-ink"),
                    )}>
                <Icon name={it.icon} className={variant === "bottom" ? "text-lg" : undefined} />
                <span className={variant === "bottom" ? "truncate" : undefined}>{it.label}</span>
                {variant === "bottom" && active && <span className="sr-only"> (current page)</span>}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
