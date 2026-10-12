import { requireRole } from "@/lib/auth/session";
import { integrationStatus } from "@/lib/settings/env-status";
import { loadBlocks, loadHealth, loadHours, loadPaymentInstructions, loadPractice, loadRetention, loadSessionTypes, loadStaff, loadTemplates } from "@/lib/settings/load";
import { canEditSection, parseSection, SECTIONS, sectionHref, settingsNotice, type SectionKey } from "@/lib/settings/sections";
import { supabaseServer } from "@/lib/supabase/server";
import { BlockedSection, HoursSection, InformationSection, PaymentSection, PracticeSection, ReadOnlyNotice, RetentionSection, SessionTypesSection } from "@/components/settings/sections";
import { LinkButton } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";

export const metadata = { title: "Settings" };

const LOAD_FAILED = <Notice tone="error"><p>We could not load these settings. Please refresh the page.</p></Notice>;

/**
 * Practice settings (psychologist and admin; everyone else gets a 404). The psychologist edits; the admin sees every value but no form, except blocked time and
 * leave (the admin is the receptionist, and RLS allows it). Every read uses the signed-in user's own client, so the database still decides what is visible, and the
 * integrations panel only ever receives yes/no answers (lib/settings/env-status.ts), never an environment value.
 */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ section?: string; notice?: string; clash?: string }> }) {
  const me = await requireRole(["psychologist", "admin"]);
  const sp = await searchParams;
  const section: SectionKey = parseSection(sp.section);
  const canEdit = canEditSection(me.role, section);
  const isPsychologist = me.role === "psychologist";
  const notice = settingsNotice(sp.notice);
  const clash = sp.notice === "block_added" && /^\d{1,3}$/.test(sp.clash ?? "") ? Number(sp.clash) : 0;
  const sb = await supabaseServer();
  const now = new Date();

  let body: React.ReactNode;
  if (section === "practice") {
    const { practice, failed } = await loadPractice(sb);
    body = practice && !failed ? <PracticeSection practice={practice} canEdit={canEdit} /> : LOAD_FAILED;
  } else if (section === "payment") {
    const text = await loadPaymentInstructions(sb);
    body = text === null ? LOAD_FAILED : <PaymentSection text={text} canEdit={canEdit} />;
  } else if (section === "session-types") {
    const { rows, failed } = await loadSessionTypes(sb);
    body = failed ? LOAD_FAILED : <SessionTypesSection types={rows} canEdit={canEdit} />;
  } else if (section === "hours") {
    const { days, failed } = await loadHours(sb);
    body = failed ? LOAD_FAILED : <HoursSection days={days} canEdit={canEdit} />;
  } else if (section === "blocked") {
    const { rows, failed } = await loadBlocks(sb, now);
    body = failed ? LOAD_FAILED : <BlockedSection blocks={rows} canEdit={canEdit} added={clash} />;
  } else if (section === "retention") {
    const { rows, failed } = isPsychologist ? await loadRetention(sb) : { rows: [], failed: false };
    body = failed ? LOAD_FAILED : <RetentionSection rows={rows} canEdit={canEdit} visible={isPsychologist} />;
  } else {
    const [templates, staff, health] = await Promise.all([loadTemplates(sb), loadStaff(sb), loadHealth(sb, isPsychologist)]);
    body = <InformationSection templates={templates.rows} staff={staff.rows} status={integrationStatus()} cron={health.cron} cronVisible={health.cronVisible} failedNotifications={health.failedNotifications} />;
  }

  return (
    <>
      <PageHeader title="Settings" description="How the practice runs: details, sessions, hours and records. Only the practitioner can change most of it." />
      {notice && <Notice tone="success">{notice}</Notice>}
      {!isPsychologist && <ReadOnlyNotice extra={section === "blocked" ? "You can add and remove blocked time and leave." : "You can see everything on this page, and add or remove blocked time and leave."} />}

      <nav aria-label="Settings sections" className="mb-6">
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {SECTIONS.map((s) => (
            <li key={s.key}>
              <LinkButton href={sectionHref(s.key)} variant={s.key === section ? "primary" : "secondary"} aria-current={s.key === section ? "page" : undefined}>{s.label}</LinkButton>
            </li>
          ))}
        </ul>
      </nav>
      {body}
    </>
  );
}
