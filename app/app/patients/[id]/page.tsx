import Link from "next/link";
import { notFound } from "next/navigation";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/session";
import { hrefWith } from "@/lib/patients/list";
import { patientNotice } from "@/lib/patients/notices";
import { patientId } from "@/lib/patients/input";
import { PATIENT_COLUMNS, type PatientRecord } from "@/lib/patients/record";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";
import { cx } from "@/lib/cx";
import { Notice } from "@/components/ui/notice";
import { RecordHeader } from "./record-header";
import { pickTab, tabsFor } from "./tabs";

export const metadata = { title: "Patient record" };

/**
 * A patient's record. Psychologist and admin only (associate, bookkeeper and everyone else get a 404). Every load is audited
 * (patient.view) before anything is shown: if the audit write fails the page fails, because a record must not be read unrecorded.
 */
export default async function PatientRecordPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireRole(["psychologist", "admin"]);
  const id = patientId.safeParse((await params).id);
  if (!id.success) notFound();
  const sp = await searchParams;

  const sb = await supabaseServer();
  const { data } = await sb.from("patients").select(PATIENT_COLUMNS).eq("id", id.data).maybeSingle();
  const patient = data as PatientRecord | null;
  if (!patient) notFound();
  await audit("patient.view", "patients", patient.id);

  const tab = pickTab(me.role, sp.tab);
  if (!tab) notFound();
  const today = sastDate(new Date());
  const notice = patientNotice(sp.notice);
  const base = `/app/patients/${patient.id}`;

  return (
    <>
      <RecordHeader patient={patient} today={today} />
      {notice && <Notice tone="success">{notice}</Notice>}
      <nav aria-label="Patient record sections" className="mb-6 border-b border-line">
        <ul className="m-0 flex list-none gap-1 overflow-x-auto p-0">
          {tabsFor(me.role).map((t) => (
            <li key={t.key}>
              <Link href={hrefWith(base, { tab: t.key })} aria-current={t.key === tab.key ? "page" : undefined}
                    className={cx("inline-flex min-h-11 items-center whitespace-nowrap border-b-4 px-4 font-medium no-underline",
                      t.key === tab.key ? "border-sage-700 text-ink" : "border-transparent text-ink-muted hover:text-ink")}>
                {t.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <section aria-labelledby="tab-h">
        <h2 id="tab-h" className="mb-4">{tab.label}</h2>
        {await tab.render({ patient, role: me.role, sb, query: sp, today })}
      </section>
    </>
  );
}
