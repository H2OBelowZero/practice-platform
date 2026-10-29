import Link from "next/link";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { getSlots } from "@/lib/booking/availability";
import { BOOKING_ERROR_TEXT, isBookingErrorCode } from "@/lib/booking/errors";
import { bookingUrl, parseBookParams, startInBookingWindow } from "@/lib/booking/input";
import { durationLabel, formatLabel } from "@/lib/booking/labels";
import { formatZar } from "@/lib/money";
import { getPractice } from "@/lib/practice";
import { supabaseServer } from "@/lib/supabase/server";
import { bookingDateRange, isBookableDate, sastDate, sastDateLabel, sastTime } from "@/lib/time";
import { cx } from "@/lib/cx";
import { Button, LinkButton } from "@/components/ui/button";
import { Card, Panel } from "@/components/ui/card";
import { Input } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { PageHeader } from "@/components/ui/page-header";
import { pageMeta } from "@/lib/seo";
import { ConfirmForm } from "./confirm-form";

// Canonical drops the date/slot query so every booking-step URL consolidates on /book.
export const metadata = pageMeta("/book", "Book a psychologist appointment online in Randburg", "Choose a session time online with a psychologist serving Randburg, Johannesburg, Sandton and Gauteng. Secure forms and payment, no account needed to look.");

type SessionType = { id: string; name: string; duration_min: number; fee_cents: number; format: string };
const STEPS = ["Session", "Date and time", "Your account", "Confirm"];

function Steps({ current }: { current: number }) {
  return (
    <ol aria-label="Booking steps" className="mb-8 flex flex-wrap gap-x-5 gap-y-2 text-sm">
      {STEPS.map((s, i) => (
        <li key={s} aria-current={i + 1 === current ? "step" : undefined}
            className={cx("flex items-center gap-2", i + 1 === current ? "font-semibold text-ink" : "text-ink-muted")}>
          <span className={cx("flex h-6 w-6 items-center justify-center rounded-full text-xs", i + 1 === current ? "bg-sage-700 text-white" : "bg-sunk text-ink-muted")}>{i + 1}</span>
          <span>{s}<span className="sr-only">{i + 1 < current ? " (done)" : i + 1 === current ? " (current step)" : ""}</span></span>
        </li>
      ))}
    </ol>
  );
}

const Summary = ({ type }: { type: SessionType }) => (
  <p className="mb-6 text-ink-muted">
    <strong className="text-ink">{type.name}</strong>: {durationLabel(type.duration_min)}, {formatLabel(type.format)}, {formatZar(type.fee_cents)}.{" "}
    <Link href="/book">Change session</Link>
  </p>
);

export default async function BookPage({ searchParams }: { searchParams: Promise<{ type?: string; date?: string; start?: string; e?: string }> }) {
  const sp = await searchParams;
  const { typeId, date, startIso } = parseBookParams(sp);
  const error = isBookingErrorCode(sp.e) ? BOOKING_ERROR_TEXT[sp.e] : undefined;
  const now = new Date();
  const range = bookingDateRange(now);

  const sb = await supabaseServer();
  const { data } = await sb.from("session_types").select("id, name, duration_min, fee_cents, format").eq("active", true).order("name");
  const types = (data ?? []) as SessionType[];
  const type = types.find((t) => t.id === typeId);
  const errorNotice = error && <Notice tone="error">{error}</Notice>;

  // ---- step 1: session type ----------------------------------------------------------------------------------------------
  if (!type) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Book an appointment" description="Choose the kind of session you would like." />
        <Steps current={1} />
        {errorNotice}
        {types.length === 0 ? (
          <Notice tone="info">No sessions are open for online booking right now. Please contact the practice.</Notice>
        ) : (
          <form method="get" action="/book" className="grid gap-4">
            {types.map((t) => (
              <button key={t.id} type="submit" name="type" value={t.id}
                      className="rounded-card border border-line bg-surface p-5 text-left shadow-card transition-colors duration-150 hover:border-sage-500 hover:bg-sage-100">
                <span className="block font-serif text-xl font-semibold">{t.name}</span>
                <span className="mt-1 block text-ink-muted">{durationLabel(t.duration_min)} · {formatLabel(t.format)} · {formatZar(t.fee_cents)}</span>
              </button>
            ))}
          </form>
        )}
      </div>
    );
  }

  // ---- step 2: date and time ---------------------------------------------------------------------------------------------
  if (!startIso || !startInBookingWindow(startIso, now)) {
    const dateOk = date !== undefined && isBookableDate(date, now);
    let slots: string[] = [];
    let slotsFailed = false;
    if (dateOk) { try { slots = await getSlots(type.id, date); } catch { slotsFailed = true; } }
    return (
      <div className="max-w-3xl">
        <PageHeader title="Choose a date and time" />
        <Steps current={2} />
        <Summary type={type} />
        {errorNotice}
        <form method="get" action="/book" className="mb-8 flex flex-wrap items-end gap-3">
          <input type="hidden" name="type" value={type.id} />
          <div className="min-w-56 flex-1">
            <Input id="date" label="Date" type="date" required min={range.min} max={range.max} defaultValue={date ?? range.min}
                   hint={`Available from ${sastDateLabel(range.min)} up to 60 days ahead.`} />
          </div>
          <Button type="submit" variant="secondary" className="mb-5">Show available times</Button>
        </form>
        {date !== undefined && !dateOk && <Notice tone="warning">Please choose a date between {sastDateLabel(range.min)} and {sastDateLabel(range.max)}.</Notice>}
        {slotsFailed && <Notice tone="error">We could not load the available times. Please try again in a moment.</Notice>}
        {dateOk && !slotsFailed && (
          <section aria-labelledby="slots-h">
            <h2 id="slots-h" className="mb-1">{sastDateLabel(date)}</h2>
            <p className="mb-4 text-sm text-ink-muted">Times are South African Standard Time (SAST).</p>
            {slots.length === 0 ? (
              <Notice tone="info">There are no free times on this day. Please try another date.</Notice>
            ) : (
              <form method="get" action="/book" className="flex flex-wrap gap-3">
                <input type="hidden" name="type" value={type.id} />
                <input type="hidden" name="date" value={date} />
                {slots.map((iso) => (
                  <button key={iso} type="submit" name="start" value={iso}
                          className="min-h-11 min-w-24 rounded-xl border border-line-strong bg-surface px-4 py-2 text-base font-medium tabular-nums transition-colors duration-150 hover:border-sage-700 hover:bg-sage-100">
                    {sastTime(iso)}
                  </button>
                ))}
              </form>
            )}
          </section>
        )}
      </div>
    );
  }

  // ---- steps 3 and 4: a time is chosen. Make sure it is still free before asking anyone to sign in or confirm. --------------
  let slots: string[];
  try { slots = await getSlots(type.id, sastDate(startIso)); } catch { slots = []; }
  if (!slots.includes(startIso)) redirect(`/book?type=${type.id}&date=${sastDate(startIso)}&e=taken`);

  const here = bookingUrl(type.id, startIso);
  const chosen = (
    <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-2">
      <dt className="text-ink-muted">Session</dt><dd className="font-medium">{type.name}</dd>
      <dt className="text-ink-muted">Date</dt><dd className="font-medium">{sastDateLabel(startIso)}</dd>
      <dt className="text-ink-muted">Time</dt><dd className="font-medium">{sastTime(startIso)} (SAST)</dd>
      <dt className="text-ink-muted">Duration</dt><dd className="font-medium">{durationLabel(type.duration_min)}</dd>
      <dt className="text-ink-muted">Format</dt><dd className="font-medium">{formatLabel(type.format)}</dd>
      <dt className="text-ink-muted">Fee</dt><dd className="font-medium">{formatZar(type.fee_cents)}</dd>
    </dl>
  );
  const changeTime = <Link href={`/book?type=${type.id}&date=${sastDate(startIso)}`}>Choose a different time</Link>;

  const me = await currentUser(sb);
  if (!me) {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Sign in to continue" description="You have chosen a time. Sign in or create an account to confirm it." />
        <Steps current={3} />
        <Card>{chosen}
          <div className="flex flex-wrap gap-3">
            <LinkButton href={`/login?next=${encodeURIComponent(here)}`}>Sign in</LinkButton>
            <LinkButton href={`/register?next=${encodeURIComponent(here)}`} variant="secondary">Create an account</LinkButton>
          </div>
          <p className="mt-5 text-sm text-ink-muted">After signing in you will come straight back to this step. {changeTime}.</p>
        </Card>
      </div>
    );
  }

  if (me.role !== "patient") {
    return (
      <div className="max-w-3xl">
        <PageHeader title="Confirm your booking" />
        <Steps current={4} />
        {me.role === "guardian"
          ? <Notice tone="info" title="Guardian account">Guardians will be able to book for the person they care for from the portal in a later step. For now, please contact the practice.</Notice>
          : <Notice tone="info" title="Staff account">Staff accounts cannot book appointments here. Use the calendar in the staff workspace.</Notice>}
        <LinkButton href={me.role === "guardian" ? "/portal" : "/app"} variant="secondary">Go to your workspace</LinkButton>
      </div>
    );
  }

  const practice = await getPractice();
  const windowHours = practice?.cancellation_window_hours ?? 24;
  const fee = practice?.late_cancel_fee_cents ?? 0;
  return (
    <div className="max-w-3xl">
      <PageHeader title="Confirm your booking" />
      <Steps current={4} />
      {errorNotice}
      <Card className="mb-6">
        {chosen}
        <p className="text-sm text-ink-muted">{changeTime}.</p>
      </Card>
      {practice?.approval_mode === "request" && (
        <Notice tone="info" title="This practice confirms bookings personally">
          Your request holds the time while the practice reviews it. You will be told when it is confirmed.
        </Notice>
      )}
      <Panel className="mb-6" id="terms">
        <h2 className="mb-2 text-lg">Booking and cancellation terms</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Please cancel or move your appointment at least {windowHours} hours before it starts.</li>
          <li>{fee > 0 ? `A late cancellation or a missed appointment may be charged a fee of ${formatZar(fee)}.` : "There is no fee for late cancellation, but please give as much notice as you can."}</li>
          <li>The session fee of {formatZar(type.fee_cents)} is invoiced after your appointment.</li>
        </ul>
      </Panel>
      <ConfirmForm typeId={type.id} startIso={startIso} />
    </div>
  );
}
