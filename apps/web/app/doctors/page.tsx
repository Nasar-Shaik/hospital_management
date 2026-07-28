"use client";

/**
 * Doctor management (Module D2) — the simple weekly ROSTER and LEAVE.
 *
 * Indian OPD reality: a doctor is "in" for the MORNING or the AFTERNOON, not for a grid of
 * fifteen-minute clock slots. So availability here is named SESSIONS per weekday — pick the days
 * and the parts of the day the doctor sees patients — plus LEAVE, the whole-day ranges they are
 * away. Reception reads this to know when a doctor is available; leave is the exception that wins.
 *
 * Roster administration, gated `doctor:manage` (the nav only shows it to those who hold it).
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  type DoctorRef,
  type DoctorAvailability,
  type DoctorLeave,
  type DoctorSession,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Badge, Button, Card, Field, ErrorAlert } from "../../components/ui";

const WEEKDAYS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

const SESSIONS: { value: DoctorSession; label: string; hint: string }[] = [
  { value: "morning", label: "Morning", hint: "forenoon clinic" },
  { value: "afternoon", label: "Afternoon", hint: "afternoon clinic" },
  { value: "evening", label: "Evening", hint: "evening clinic" },
  { value: "full_day", label: "Full day", hint: "in all day" },
];
const sessionLabel = (s: DoctorSession): string => SESSIONS.find((x) => x.value === s)?.label ?? s;

function fmtDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/* ── weekly session roster ───────────────────────────────────────────────────── */

function WeeklyRoster({
  doctorId,
  availability,
  onChange,
  canManage,
}: {
  doctorId: string;
  availability: DoctorAvailability[];
  onChange: () => void;
  canManage: boolean;
}) {
  const { api } = useAuth();
  const [saving, setSaving] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);

  const sessionsFor = (weekday: number): DoctorSession[] =>
    availability.find((a) => a.weekday === weekday)?.sessions ?? [];

  async function toggle(weekday: number, session: DoctorSession) {
    if (!canManage) return;
    const current = sessionsFor(weekday);
    let next: DoctorSession[];
    if (session === "full_day") {
      // Full day is exclusive — turning it on clears the part-sessions, off clears everything.
      next = current.includes("full_day") ? [] : ["full_day"];
    } else {
      next = current.includes(session)
        ? current.filter((s) => s !== session)
        : [...current.filter((s) => s !== "full_day"), session];
    }
    setSaving(weekday);
    setError(null);
    try {
      await api.setDoctorAvailability({ doctorId, weekday, sessions: next });
      onChange();
    } catch (e) {
      setError(e);
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-[var(--color-fg)]">Weekly availability</h2>
      <p className="mb-4 text-sm text-[var(--color-fg-muted)]">
        Which sessions is the doctor in each day? No fixed time slots — reception books patients
        into a session.
      </p>
      {error != null && (
        <div className="mb-3">
          <ErrorAlert error={error} fallback="Could not update the session." />
        </div>
      )}
      <div className="space-y-1.5">
        {WEEKDAYS.map((d) => {
          const selected = sessionsFor(d.value);
          return (
            <div
              key={d.value}
              className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2"
            >
              <span className="w-24 text-sm font-medium text-[var(--color-fg)]">{d.label}</span>
              <div className="flex flex-wrap gap-1.5">
                {SESSIONS.map((s) => {
                  const on = selected.includes(s.value);
                  const disabled =
                    !canManage ||
                    saving === d.value ||
                    // Part-sessions are unavailable while Full day is on, and vice-versa.
                    (s.value !== "full_day" && selected.includes("full_day")) ||
                    (s.value === "full_day" &&
                      selected.length > 0 &&
                      !selected.includes("full_day"));
                  return (
                    <button
                      key={s.value}
                      type="button"
                      disabled={disabled}
                      onClick={() => toggle(d.value, s.value)}
                      title={s.hint}
                      className={`rounded-md border px-2.5 py-1 text-xs font-medium transition-colors ${
                        on
                          ? "border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)]"
                          : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:border-[var(--color-brand-500)] disabled:opacity-40 disabled:hover:border-[var(--color-border-strong)]"
                      }`}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
              {selected.length === 0 && (
                <span className="text-xs text-[var(--color-fg-subtle)]">— not in —</span>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

/* ── leave ─────────────────────────────────────────────────────────────────── */

function LeavePanel({
  doctorId,
  leave,
  onChange,
  canManage,
}: {
  doctorId: string;
  leave: DoctorLeave[];
  onChange: () => void;
  canManage: boolean;
}) {
  const { api } = useAuth();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!from || !to) return;
    setSaving(true);
    setError(null);
    try {
      await api.addDoctorLeave({
        doctorId,
        fromDate: from,
        toDate: to,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setFrom("");
      setTo("");
      setReason("");
      onChange();
    } catch (e2) {
      setError(e2);
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    try {
      await api.removeDoctorLeave(id);
      onChange();
    } catch (e2) {
      setError(e2);
    }
  }

  return (
    <Card className="p-5">
      <h2 className="mb-1 font-semibold text-[var(--color-fg)]">Leave &amp; time off</h2>
      <p className="mb-4 text-sm text-[var(--color-fg-muted)]">
        Whole days the doctor is away — no sessions are offered and no patient can be booked on
        these days, whatever the weekly roster says.
      </p>
      {error != null && (
        <div className="mb-3">
          <ErrorAlert error={error} fallback="Could not save the leave." />
        </div>
      )}

      {leave.length === 0 ? (
        <p className="mb-4 text-sm text-[var(--color-fg-subtle)]">No leave recorded.</p>
      ) : (
        <ul className="mb-4 space-y-1.5">
          {leave.map((l) => (
            <li
              key={l.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] px-3 py-2"
            >
              <span className="text-sm text-[var(--color-fg)]">
                {fmtDate(l.fromDate)}
                {l.toDate !== l.fromDate && <> &ndash; {fmtDate(l.toDate)}</>}
                {l.reason && (
                  <span className="ml-2 text-xs text-[var(--color-fg-subtle)]">{l.reason}</span>
                )}
              </span>
              {canManage && (
                <button
                  className="text-xs text-[var(--color-danger)] hover:underline"
                  onClick={() => void remove(l.id)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <form className="flex flex-wrap items-end gap-3" onSubmit={add}>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">From</span>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              required
              className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/30"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">To</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              required
              className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm outline-none focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/30"
            />
          </label>
          <div className="min-w-40 flex-1">
            <Field
              label="Reason (optional)"
              name="reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Conference, sick, vacation…"
            />
          </div>
          <Button type="submit" loading={saving}>
            Add leave
          </Button>
        </form>
      )}
    </Card>
  );
}

/* ── page ──────────────────────────────────────────────────────────────────── */

function DoctorsPage() {
  const { api, can } = useAuth();
  const canManage = can("doctor:manage");
  const [doctors, setDoctors] = useState<DoctorRef[]>([]);
  const [doctorId, setDoctorId] = useState("");
  const [availability, setAvailability] = useState<DoctorAvailability[]>([]);
  const [leave, setLeave] = useState<DoctorLeave[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    api
      .listDoctors()
      .then((d) => {
        setDoctors(d);
        const first = d[0];
        if (first) setDoctorId((cur) => cur || first.id);
      })
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api]);

  const loadRoster = useCallback(() => {
    if (!doctorId) return;
    Promise.all([api.getDoctorAvailability(doctorId), api.getDoctorLeave(doctorId)])
      .then(([a, l]) => {
        setAvailability(a);
        setLeave(l);
      })
      .catch((e: unknown) => setError(e));
  }, [api, doctorId]);

  useEffect(loadRoster, [loadRoster]);

  const selected = doctors.find((d) => d.id === doctorId);
  const activeDays = availability.filter((a) => a.sessions.length > 0).length;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-[var(--color-fg)]">Doctors</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Set each doctor&apos;s weekly sessions and leave — the roster reception books against.
        </p>
      </div>

      {error != null && <ErrorAlert error={error} fallback="Could not load doctors." />}

      {loading ? (
        <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>
      ) : doctors.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-[var(--color-fg-muted)]">
            No doctors yet. Add a staff member with the Doctor role to build a roster.
          </p>
        </Card>
      ) : (
        <>
          <Card className="p-5">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">
                Doctor
              </span>
              <select
                value={doctorId}
                onChange={(e) => setDoctorId(e.target.value)}
                className="w-full max-w-sm rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/30"
              >
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            {selected && (
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <Badge tone={activeDays > 0 ? "success" : "neutral"}>
                  {activeDays > 0
                    ? `In ${activeDays} day${activeDays > 1 ? "s" : ""}/week`
                    : "No sessions set"}
                </Badge>
                {availability
                  .filter((a) => a.sessions.length > 0)
                  .flatMap((a) => a.sessions)
                  .filter((s, i, arr) => arr.indexOf(s) === i)
                  .map((s) => (
                    <Badge key={s} tone="brand">
                      {sessionLabel(s)}
                    </Badge>
                  ))}
              </div>
            )}
          </Card>

          {doctorId && (
            <>
              <WeeklyRoster
                doctorId={doctorId}
                availability={availability}
                onChange={loadRoster}
                canManage={canManage}
              />
              <LeavePanel
                doctorId={doctorId}
                leave={leave}
                onChange={loadRoster}
                canManage={canManage}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}

export default function Page() {
  return <DoctorsPage />;
}
