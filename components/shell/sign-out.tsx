import { signOut } from "@/app/(auth)/actions";
import { cx } from "@/lib/cx";
import { Icon } from "@/components/ui/icon";

/** Sign-out via the existing audited server action. `dark` styles it for the sage sidebar. */
export function SignOutButton({ dark, className }: { dark?: boolean; className?: string }) {
  return (
    <form action={signOut}>
      <button type="submit"
              className={cx("flex min-h-11 w-full items-center gap-3 rounded-xl px-3 py-2 text-base transition-colors duration-150",
                dark ? "text-sage-100 hover:bg-sage-800 hover:text-white" : "text-ink hover:bg-sunk", className)}>
        <Icon name="logout" />Sign out
      </button>
    </form>
  );
}
