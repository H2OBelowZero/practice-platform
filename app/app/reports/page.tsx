import { requireRole } from "@/lib/auth/session";
import { PHASE_NOTE } from "@/lib/reports/definitions";
import { parseTab, REPORT_ROLES, tabsFor } from "@/lib/reports/keys";
import { loadActivityReport, loadAppointmentsReport, loadComplianceReport, loadFinancial } from "@/lib/reports/load";
import { parsePeriod } from "@/lib/reports/periods";
import { supabaseServer } from "@/lib/supabase/server";
import { sastDate } from "@/lib/time";
import { ActivityReport, AppointmentsReport, ComplianceReport } from "@/components/reports/practice";
import { PeriodControls, ReportTabs } from "@/components/reports/controls";
import { FinancialReport } from "@/components/reports/financial";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";

export const metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

/**
 * Practice reports. Psychologist, admin and bookkeeper may open the page (requireRole here, not only in the layout, R26); what each sees is decided by the role:
 * a bookkeeper has the Financial report only (no patient names), the admin everything except Compliance, the psychologist all four. Every figure comes from a
 * report_* database function (0025) called as the signed-in user, so row security and the function's own role guard apply on top of this page. A tab the role may not
 * see is never queried: asking for it shows the first tab the role may see. The period is a SAST date range from the URL, checked on the server.
 */
export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ report?: string; preset?: string; from?: string; to?: string }> }) {
  const { role } = await requireRole(REPORT_ROLES);
  const sp = await searchParams;
  const today = sastDate(new Date());
  const period = parsePeriod(sp, today);
  const tabs = tabsFor(role).map(({ key, label }) => ({ key, label }));
  const tab = parseTab(sp.report, role);
  const sb = await supabaseServer();

  return (
    <>
      <PageHeader title="Reports" description="How the practice is doing: money, the diary, and activity. Dates are South African dates." />
      <ReportTabs tabs={tabs} current={tab} period={period} />
      <PeriodControls report={tab} period={period} />
      {period.problem && <Notice tone="warning" title="Those dates could not be used"><p>{period.problem} Showing the last 3 months instead.</p></Notice>}
      <p className="mb-6 text-sm text-ink-muted">{PHASE_NOTE}</p>

      {tab === "financial" && <FinancialReport f={await loadFinancial(sb, role, period, today)} role={role} period={period} />}
      {tab === "appointments" && <AppointmentsReport s={await loadAppointmentsReport(sb, period)} period={period} />}
      {tab === "activity" && <ActivityReport s={await loadActivityReport(sb, period)} period={period} />}
      {tab === "compliance" && <ComplianceReport s={await loadComplianceReport(sb, period)} period={period} />}
    </>
  );
}
