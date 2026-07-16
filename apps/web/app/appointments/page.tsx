"use client";

/**
 * Appointments (Doc 02 E1) — the doctor's day, and the desk that fills it.
 *
 * ── DESIGNED FOR A QUEUE OF PEOPLE, NOT FOR A DEMO ───────────────────────────
 * One screen, one day, one doctor. Pick the doctor, pick the day, and the open
 * slots appear as a grid you click. There is no "new appointment" form with a
 * free-text time field, because a free-text time can be 03:47 — a slot the doctor
 * has no clinic for, which the server would reject anyway. Offering only real
 * slots means the only bookings a clerk *can* make are ones that exist.
 *
 * ── THE SLOT GRID IS A HINT, NOT A RESERVATION ───────────────────────────────
 * A slot shown here can be taken by another desk a second later. The server does
 * not trust this screen and neither should the user: booking races are decided by
 * a unique index, and the loser gets HMS-APT-001 *carrying alternatives*. So when
 * that happens we do not just say "failed" — we refresh the grid and say which
 * slot went, so the clerk can rebook in the same motion with the patient still
 * standing there. That recovery path is the difference between a usable front desk
 * and one that gets worked around on paper.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ApiClientError,
  type Appointment,
  type AppointmentStatus,
  type Patient,
  type DoctorRef,
  type Slot,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Protected } from "../../components/Protected";
import { Alert, Badge, Button, Card, PermissionGate } from "../../components/ui";

function toDateInput(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function statusTone(status: AppointmentStatus): "success" | "danger" | "brand" | "neutral" {
  if (status === "cancelled" || status === "no_show") return "danger";
  if (status === "completed") return "success";
  if (status === "checked_in" || status === "in_consultation") return "brand";
  return "neutral";
}

/**
 * What a clerk can do NEXT to this appointment — derived from the state machine,
 * so the buttons cannot offer an edge the server would refuse
 * (STATE_MACHINE_CATALOG §1). A button that 422s is a button that should not have
 * been drawn.
 */
function nextActions(status: AppointmentStatus): { label: string; action: string }[] {
  switch (status) {
    case "requested":
      return [{ label: "Confirm", action: "confirm" }];
    case "confirmed":
      return [
        { label: "Check in", action: "checkIn" },
        { label: "No show", action: "noShow" },
      ];
    case "checked_in":
      return [{ label: "Start consultation", action: "start" }];
    case "in_consultation":
      return [{ label: "Complete", action: "complete" }];
    default:
      return [];
  }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** `09:00` ⇄ minutes-from-midnight, which is how the API stores a time of day. */
function toMinutes(hhmm: string): number {
  const [h = "0", m = "0"] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}
function toHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * A doctor's weekly clinic hours — the template every bookable slot is derived
 * from. One row per weekday; saving replaces that day's session (the API upserts
 * on `{doctorId, weekday}`).
 *
 * Deliberately here rather than on a separate "doctor profile" screen that does
 * not exist yet: the person who discovers there are no slots is the person who
 * needs to fix it, and making them navigate elsewhere is how a clinic ends up
 * being booked on paper.
 */
function ClinicHours({ doctorId, onSaved }: { doctorId: string; onSaved: () => void }) {
  const { api } = useAuth();

  const [weekday, setWeekday] = useState(1);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("13:00");
  const [slotMinutes, setSlotMinutes] = useState(15);
  const [existing, setExisting] = useState<{ weekday: number; label: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!doctorId) return;
    void api
      .getDoctorSchedule(doctorId)
      .then((rows) =>
        setExisting(
          rows.map((r) => ({
            weekday: r.weekday,
            label: `${WEEKDAYS[r.weekday] ?? ""} ${toHHMM(r.startMinute)}–${toHHMM(r.endMinute)} · ${String(r.slotMinutes)} min`,
          })),
        ),
      )
      .catch(() => undefined);
  }, [api, doctorId]);

  useEffect(refresh, [refresh]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.setDoctorSchedule({
        doctorId,
        weekday,
        startMinute: toMinutes(start),
        endMinute: toMinutes(end),
        slotMinutes,
      });
      refresh();
      onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not save the hours.");
    } finally {
      setSaving(false);
    }
  }

  if (!doctorId) return null;

  return (
    <Card>
      <h2 className="mb-1 text-sm font-semibold text-[var(--color-fg)]">Clinic hours</h2>
      <p className="mb-3 text-xs text-[var(--color-fg-muted)]">
        A weekly pattern. Slots are generated from it — they are not stored, so changing the hours
        changes what can be booked from now on.
      </p>

      {error && (
        <p className="mb-3 text-sm text-[var(--color-danger)]" role="alert">
          {error}
        </p>
      )}

      {existing.length > 0 && (
        <ul className="mb-4 flex flex-wrap gap-2">
          {existing.map((row) => (
            <li key={row.weekday}>
              <Badge tone="brand">{row.label}</Badge>
            </li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-5">
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-xs font-medium text-[var(--color-fg-muted)]">Day</span>
          <select
            value={weekday}
            onChange={(e) => setWeekday(Number(e.target.value))}
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
          >
            {WEEKDAYS.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--color-fg-muted)]">
            From
          </span>
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--color-fg-muted)]">To</span>
          <input
            type="time"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
          />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-xs font-medium text-[var(--color-fg-muted)]">
            Slot (min)
          </span>
          <input
            type="number"
            min={5}
            max={240}
            step={5}
            value={slotMinutes}
            onChange={(e) => setSlotMinutes(Number(e.target.value))}
            className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)]"
          />
        </label>
      </div>

      <Button className="mt-4" disabled={saving} onClick={() => void save()}>
        {saving ? "Saving…" : "Save clinic hours"}
      </Button>
    </Card>
  );
}

function Appointments() {
  const { api, can } = useAuth();

  const [doctors, setDoctors] = useState<DoctorRef[]>([]);
  const [doctorId, setDoctorId] = useState("");
  const [day, setDay] = useState(toDateInput(new Date()));

  const [slots, setSlots] = useState<Slot[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);

  const [patientId, setPatientId] = useState("");
  const [reason, setReason] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  /**
   * The doctors directory (`GET /doctors`, `encounter:read`).
   *
   * This used to call `listStaff`, which needs `user:read` — a permission the
   * RECEPTIONIST does not hold. So this screen's doctor picker was permanently empty
   * for the one person who uses it most, and the page was unusable for them. It is
   * still one source of truth about who works here; it just asks the smaller question.
   */
  useEffect(() => {
    void api
      .listDoctors()
      .then((docs) => {
        setDoctors(docs);
        setDoctorId((current) => current || (docs[0]?.id ?? ""));
      })
      .catch(() => setError("Could not load doctors."));

    void api
      .listPatients({ limit: 100 })
      .then((page) => setPatients(page.items))
      .catch(() => undefined);
  }, [api]);

  const load = useCallback(async () => {
    if (!doctorId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const date = new Date(`${day}T00:00:00`);
      const from = new Date(date);
      const to = new Date(date);
      to.setDate(to.getDate() + 1);

      const [open, booked] = await Promise.all([
        api.getAvailability(doctorId, date),
        api.listAppointments({ doctorId, from, to, limit: 100 }),
      ]);

      setSlots(open);
      setAppointments(booked.items);
      setError(null);
    } catch (err) {
      // HMS-PLAN-002: this hospital never bought scheduling. Say so plainly —
      // "not in your edition" is a sales conversation, not a permissions one.
      if (err instanceof ApiClientError && err.code === "HMS-PLAN-002") {
        setError("Appointments are not part of your current plan. Contact your account manager.");
      } else {
        setError(err instanceof ApiClientError ? err.message : "Could not load the day.");
      }
    } finally {
      setLoading(false);
    }
  }, [api, doctorId, day]);

  useEffect(() => {
    void load();
  }, [load]);

  async function book(slot: Slot) {
    if (!patientId) {
      setError("Choose a patient first.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      await api.bookAppointment({
        patientId,
        doctorId,
        startAt: new Date(slot.startAt),
        ...(reason ? { reason } : {}),
      });
      setNotice(`Booked ${time(slot.startAt)}.`);
      setReason("");
      await load();
    } catch (err) {
      if (err instanceof ApiClientError && err.code === "HMS-APT-001") {
        /**
         * Someone else took it while this clerk was choosing. The server sent
         * alternatives; refreshing the grid shows them. Telling the user WHICH slot
         * went — rather than "booking failed" — is what lets them recover without
         * starting over.
         */
        setError(`${time(slot.startAt)} was just taken by another desk. Pick another slot.`);
        await load();
      } else {
        setError(err instanceof ApiClientError ? err.message : "Could not book the slot.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function act(appointment: Appointment, action: string) {
    setBusy(true);
    setError(null);
    try {
      if (action === "confirm") await api.confirmAppointment(appointment.id);
      if (action === "checkIn") await api.checkInAppointment(appointment.id);
      if (action === "start") await api.startConsultation(appointment.id);
      if (action === "complete") await api.completeAppointment(appointment.id);
      if (action === "noShow") await api.markNoShow(appointment.id);
      if (action === "cancel") {
        // A reason is required by the API, and rightly: "cancelled" with no why is
        // useless to the doctor whose list just shrank.
        const why = window.prompt("Why is this appointment being cancelled?");
        if (!why) {
          setBusy(false);
          return;
        }
        await api.cancelAppointment(appointment.id, why);
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not update the appointment.");
    } finally {
      setBusy(false);
    }
  }

  const nameOf = (id: string): string =>
    patients.find((p) => p.id === id)?.name ?? "Unknown patient";
  const uhidOf = (id: string): string => patients.find((p) => p.id === id)?.uhid ?? "";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Appointments</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          One doctor, one day. Click an open slot to book it.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <Card>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">Doctor</span>
            <select
              value={doctorId}
              onChange={(e) => setDoctorId(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)]"
            >
              {doctors.length === 0 && <option value="">No doctors yet</option>}
              {doctors.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">Day</span>
            <input
              type="date"
              value={day}
              onChange={(e) => setDay(e.target.value)}
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)]"
            />
          </label>

          <PermissionGate can={can} permission="appointment:create">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">
                Patient to book
              </span>
              <select
                value={patientId}
                onChange={(e) => setPatientId(e.target.value)}
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)]"
              >
                <option value="">Choose a patient…</option>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {p.uhid}
                  </option>
                ))}
              </select>
            </label>
          </PermissionGate>
        </div>

        <PermissionGate can={can} permission="appointment:create">
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason for visit (optional)"
            className="mt-4 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)] outline-none"
          />
        </PermissionGate>
      </Card>

      {/* ── the slot grid ── */}
      <PermissionGate can={can} permission="appointment:create">
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">Open slots</h2>

          {loading ? (
            <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">Loading…</p>
          ) : slots.length === 0 ? (
            <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
              No open slots — this doctor has no clinic session on{" "}
              {new Date(`${day}T00:00:00`).toLocaleDateString([], { weekday: "long" })}s, or the day
              is fully booked. Set their hours below.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {slots.map((slot) => (
                <button
                  key={slot.startAt}
                  type="button"
                  disabled={busy || !patientId}
                  onClick={() => void book(slot)}
                  title={patientId ? "Book this slot" : "Choose a patient first"}
                  className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-fg)] transition-colors hover:border-[var(--color-brand-500)] hover:bg-[var(--color-brand-50)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {time(slot.startAt)}
                </button>
              ))}
            </div>
          )}
        </Card>
      </PermissionGate>

      {/* ── clinic hours (Doc 02 D2) — roster administration, not front-desk work ── */}
      <PermissionGate can={can} permission="doctor:manage">
        <ClinicHours doctorId={doctorId} onSaved={() => void load()} />
      </PermissionGate>

      {/* ── the doctor's day ── */}
      <Card>
        <h2 className="mb-3 text-sm font-semibold text-[var(--color-fg)]">The doctor&apos;s day</h2>

        {appointments.length === 0 ? (
          <p className="py-6 text-center text-sm text-[var(--color-fg-subtle)]">
            Nothing booked for this day.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-[var(--color-border)] text-xs text-[var(--color-fg-subtle)] uppercase">
                <tr>
                  <th className="py-2 pr-4">Time</th>
                  <th className="py-2 pr-4">Token</th>
                  <th className="py-2 pr-4">Patient</th>
                  <th className="py-2 pr-4">Status</th>
                  <th className="py-2">Next</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border)]">
                {appointments.map((a) => (
                  <tr key={a.id}>
                    <td className="py-2.5 pr-4 font-medium text-[var(--color-fg)]">
                      {time(a.startAt)}
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-[var(--color-fg-muted)]">
                      {a.encounterId ? "in queue" : "—"}
                    </td>
                    <td className="py-2.5 pr-4">
                      <span className="text-[var(--color-fg)]">{nameOf(a.patientId)}</span>{" "}
                      <span className="font-mono text-xs text-[var(--color-fg-muted)]">
                        {uhidOf(a.patientId)}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4">
                      <Badge tone={statusTone(a.status)}>{a.status.replace("_", " ")}</Badge>
                    </td>
                    <td className="py-2.5">
                      <div className="flex flex-wrap gap-1.5">
                        {/* Only edges the state machine actually allows are drawn. */}
                        {can("appointment:update") &&
                          nextActions(a.status).map((next) => (
                            <Button
                              key={next.action}
                              variant="secondary"
                              disabled={busy}
                              onClick={() => void act(a, next.action)}
                            >
                              {next.label}
                            </Button>
                          ))}
                        {can("appointment:cancel") &&
                          ["requested", "confirmed", "checked_in"].includes(a.status) && (
                            <Button
                              variant="ghost"
                              disabled={busy}
                              onClick={() => void act(a, "cancel")}
                            >
                              Cancel
                            </Button>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

export default function AppointmentsPage() {
  return (
    <Protected>
      <Appointments />
    </Protected>
  );
}
