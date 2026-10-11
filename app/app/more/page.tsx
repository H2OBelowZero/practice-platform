import Link from "next/link";
import { requireRole } from "@/lib/auth/session";
import { staffNav } from "@/lib/nav";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SignOutButton } from "@/components/shell/sign-out";

export const metadata = { title: "More" };

/** Phone "More" destination: every link this role may use, plus sign out. */
export default async function MorePage() {
  const me = await requireRole(["psychologist", "admin", "bookkeeper", "associate"]);
  return (
    <>
      <PageHeader title="More" />
      <Card className="p-2 sm:p-3">
        <ul>
          {staffNav(me.role).map((i) => (
            <li key={i.href}>
              <Link href={i.href} className="flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 text-ink no-underline hover:bg-sunk hover:text-ink">
                <Icon name={i.icon} />{i.label}
              </Link>
            </li>
          ))}
          <li><SignOutButton /></li>
        </ul>
      </Card>
    </>
  );
}
