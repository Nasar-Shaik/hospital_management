"use client";

/**
 * Operation theatres — the OT registry and the day's surgical schedule (Module B5).
 *
 * Two things on one screen: the BOARD (today's booked procedures, each movable along its lifecycle)
 * and the REGISTRY (the theatres a hospital has). Booking rejects any window that overlaps another
 * procedure on the same theatre — the collision rule the API enforces.
 *
 * Reading needs `emr:read`; booking/moving a procedure needs `ot:schedule`; the registry needs
 * `facility:manage`. The whole feature is gated on the OT module edition flag.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  type Theatre,
  type TheatreKind,
  type OtBooking,
  type OtBookingStatus,
  type DoctorRef,
  type Patient,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { useBranch } from "../../components/BranchProvider";
import { todayInZone } from "../../lib/day";
import { Badge, Button, DataTable, Field, Modal, type Column } from "../../components/ui";
import { ErrorAlert } from "../../components/ui";

const THEATRE_KINDS: { value: TheatreKind; label: string }[] = [
  { value: "major_ot", label: "Major OT" },
  { value: "minor_ot", label: "Minor OT" },
  { value: "cath_lab", label: "Cath lab" },
  { value: "endoscopy", label: "Endoscopy" },
  { value: "labor_room", label: "Labor room" },
];
const kindLabel = (k: TheatreKind) => THEATRE_KINDS.find((x) => x.value === k)?.label ?? k;

const STATUS_TONE: Record<OtBookingStatus, "brand" | "warning" | "success" | "neutral"> = {
  scheduled: "brand",
  in_progress: "warning",
  completed: "success",
  cancelled: "neutral",
};

/** The legal next steps, mirroring the API's state machine — buttons only for what is allowed. */
const NEXT_STEPS: Record<OtBookingStatus, { to: OtBookingStatus; label: string }[]> = {
  scheduled: [
    { to: "in_progress", label: "Start" },
    { to: "cancelled", label: "Cancel" },
  ],
  in_progress: [
    { to: "completed", label: "Complete" },
    { to: "cancelled", label: "Cancel" },
  ],
  completed: [],
  cancelled: [],
};

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** `<input type="datetime-local">` gives a zone-less local string; the API wants ISO. */
const toIso = (local: string) => (local ? new Date(local).toISOString() : "");

/* ── Booking form ── */

interface BookingForm {
  theatreId: string;
  patientId: string;
  surgeonId: string;
  procedureName: string;
  scheduledStart: string;
  scheduledEnd: string;
}

function BookingModal({
  theatres,
  doctors,
  onClose,
  onBooked,
}: {
  theatres: Theatre[];
  doctors: DoctorRef[];
  onClose: () => void;
  onBooked: () => void;
}) {
  const { api } = useAuth();
  const [f, setF] = useState<BookingForm>({
    theatreId: "",
    patientId: "",
    surgeonId: "",
    procedureName: "",
    scheduledStart: "",
    scheduledEnd: "",
  });
  const set = (patch: Partial<BookingForm>) => setF((prev) => ({ ...prev, ...patch }));

  const [patientQuery, setPatientQuery] = useState("");
  const [patientHits, setPatientHits] = useState<Patient[]>([]);
  const [chosenPatient, setChosenPatient] = useState<Patient | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const searchPatients = useCallback(() => {
    if (patientQuery.trim().length < 2) return;
    api
      .listPatients({ q: patientQuery.trim(), limit: 8 })
      .then((p) => setPatientHits(p.items))
      .catch(() => setPatientHits([]));
  }, [api, patientQuery]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    api
      .createOtBooking({
        theatreId: f.theatreId,
        patientId: f.patientId,
        surgeonId: f.surgeonId,
        procedureName: f.procedureName.trim(),
        scheduledStart: toIso(f.scheduledStart),
        scheduledEnd: toIso(f.scheduledEnd),
      })
      .then(() => onBooked())
      .catch((err: unknown) => setError(err))
      .finally(() => setSaving(false));
  }

  const activeTheatres = theatres.filter((t) => t.status === "active");

  return (
    <Modal title="Book a procedure" onClose={onClose}>
      <form className="space-y-5" onSubmit={submit}>
        {error != null && <ErrorAlert error={error} fallback="Could not book the procedure." />}

        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Theatre</span>
          <select
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
            value={f.theatreId}
            onChange={(e) => set({ theatreId: e.target.value })}
            required
          >
            <option value="">— Select a theatre —</option>
            {activeTheatres.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.code})
              </option>
            ))}
          </select>
        </label>

        {/* Patient search-select */}
        <div className="space-y-2">
          <span className="block text-sm font-medium text-[var(--color-fg)]">Patient</span>
          {chosenPatient ? (
            <div className="flex items-center justify-between rounded-lg border border-[var(--color-border)] px-3 py-2 text-sm">
              <span>
                {chosenPatient.name}{" "}
                <span className="font-mono text-xs text-[var(--color-fg-muted)]">
                  {chosenPatient.uhid}
                </span>
              </span>
              <button
                type="button"
                className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
                onClick={() => {
                  setChosenPatient(null);
                  set({ patientId: "" });
                }}
              >
                Change
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-fg)]"
                placeholder="Search name or UHID…"
                value={patientQuery}
                onChange={(e) => setPatientQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    searchPatients();
                  }
                }}
              />
              <Button type="button" variant="secondary" onClick={searchPatients}>
                Search
              </Button>
            </div>
          )}
          {!chosenPatient && patientHits.length > 0 && (
            <ul className="divide-y divide-[var(--color-border)] rounded-lg border border-[var(--color-border)]">
              {patientHits.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-[var(--color-bg)]"
                    onClick={() => {
                      setChosenPatient(p);
                      set({ patientId: p.id });
                      setPatientHits([]);
                    }}
                  >
                    <span>{p.name}</span>
                    <span className="font-mono text-xs text-[var(--color-fg-muted)]">{p.uhid}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <label className="block text-sm">
          <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Surgeon</span>
          <select
            className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
            value={f.surgeonId}
            onChange={(e) => set({ surgeonId: e.target.value })}
            required
          >
            <option value="">— Select a surgeon —</option>
            {doctors.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>

        <Field
          label="Procedure"
          name="procedureName"
          value={f.procedureName}
          onChange={(e) => set({ procedureName: e.target.value })}
          placeholder="Appendectomy"
          required
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Start</span>
            <input
              type="datetime-local"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
              value={f.scheduledStart}
              onChange={(e) => set({ scheduledStart: e.target.value })}
              required
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-[var(--color-fg)]">End</span>
            <input
              type="datetime-local"
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
              value={f.scheduledEnd}
              onChange={(e) => set({ scheduledEnd: e.target.value })}
              required
            />
          </label>
        </div>

        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={!f.patientId}>
            Book procedure
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Theatre registry form ── */

function TheatreModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Theatre;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const [name, setName] = useState(initial?.name ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  const [kind, setKind] = useState<TheatreKind>(initial?.kind ?? "major_ot");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const p = initial
      ? api.updateTheatre(initial.id, { name: name.trim(), kind })
      : api.createTheatre({ name: name.trim(), code: code.trim(), kind });
    p.then(() => onSaved())
      .catch((err: unknown) => setError(err))
      .finally(() => setSaving(false));
  }

  return (
    <Modal title={initial ? `Edit ${initial.name}` : "Add theatre"} onClose={onClose}>
      <form className="space-y-5" onSubmit={submit}>
        {error != null && <ErrorAlert error={error} fallback="Could not save the theatre." />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="OT-1"
            required
          />
          <Field
            label="Code"
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            disabled={!!initial}
            hint={initial ? "The code cannot change — records carry it." : "e.g. OT1"}
            required
          />
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Kind</span>
            <select
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
              value={kind}
              onChange={(e) => setKind(e.target.value as TheatreKind)}
            >
              {THEATRE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={saving}>
            {initial ? "Save changes" : "Add theatre"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function TheatresPage() {
  const { api, can } = useAuth();
  const canSchedule = can("ot:schedule");
  const canRegistry = can("facility:manage");

  const { timezone } = useBranch();
  const [theatres, setTheatres] = useState<Theatre[]>([]);
  const [doctors, setDoctors] = useState<DoctorRef[]>([]);
  const [bookings, setBookings] = useState<OtBooking[]>([]);
  /**
   * "Today" is the SITE's today. Built from the browser's UTC offset, this board showed yesterday
   * between midnight and 05:30 in India — precisely the night shift.
   */
  const [date, setDate] = useState(() => todayInZone(timezone));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [booking, setBooking] = useState(false);
  const [theatreModal, setTheatreModal] = useState<{ initial?: Theatre } | null>(null);

  const loadBoard = useCallback(() => {
    setLoading(true);
    const from = new Date(`${date}T00:00:00`);
    const to = new Date(`${date}T00:00:00`);
    to.setDate(to.getDate() + 1);
    api
      .listOtBookings({ from: from.toISOString(), to: to.toISOString() })
      .then(setBookings)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api, date]);

  const loadRefs = useCallback(() => {
    api
      .listTheatres()
      .then(setTheatres)
      .catch(() => undefined);
    api
      .listDoctors()
      .then(setDoctors)
      .catch(() => undefined);
  }, [api]);

  useEffect(loadBoard, [loadBoard]);
  useEffect(loadRefs, [loadRefs]);

  function transition(b: OtBooking, to: OtBookingStatus) {
    api
      .transitionOtBooking(b.id, { to })
      .then(() => loadBoard())
      .catch((e: unknown) => setError(e));
  }

  function retireTheatre(t: Theatre) {
    api
      .updateTheatre(t.id, { status: t.status === "active" ? "inactive" : "active" })
      .then(() => loadRefs())
      .catch((e: unknown) => setError(e));
  }

  const sortedBookings = useMemo(
    () => [...bookings].sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart)),
    [bookings],
  );

  const bookingColumns: Column<OtBooking>[] = [
    {
      key: "time",
      header: "Time",
      cellClassName: "font-mono text-xs whitespace-nowrap text-[var(--color-fg-muted)]",
      render: (b) => `${fmtTime(b.scheduledStart)}–${fmtTime(b.scheduledEnd)}`,
    },
    {
      key: "theatre",
      header: "Theatre",
      cellClassName: "text-[var(--color-fg)]",
      render: (b) => b.theatreName,
    },
    {
      key: "procedure",
      header: "Procedure",
      cellClassName: "text-[var(--color-fg)]",
      render: (b) => b.procedureName,
    },
    {
      key: "patient",
      header: "Patient",
      render: (b) => (
        <>
          {b.patientName}{" "}
          <span className="font-mono text-xs text-[var(--color-fg-muted)]">{b.uhid}</span>
        </>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (b) => <Badge tone={STATUS_TONE[b.status]}>{b.status.replace("_", " ")}</Badge>,
    },
    ...(canSchedule
      ? ([
          {
            key: "actions",
            header: "Actions",
            align: "right",
            render: (b) => (
              <div className="flex justify-end gap-2">
                {NEXT_STEPS[b.status].map((step) => (
                  <Button
                    key={step.to}
                    size="sm"
                    variant={step.to === "cancelled" ? "ghost" : "secondary"}
                    onClick={() => transition(b, step.to)}
                  >
                    {step.label}
                  </Button>
                ))}
              </div>
            ),
          },
        ] as Column<OtBooking>[])
      : []),
  ];

  const theatreColumns: Column<Theatre>[] = [
    {
      key: "name",
      header: "Theatre",
      cellClassName: "font-medium text-[var(--color-fg)]",
      render: (t) => t.name,
    },
    {
      key: "code",
      header: "Code",
      cellClassName: "font-mono text-xs text-[var(--color-fg-muted)]",
      render: (t) => t.code,
    },
    {
      key: "kind",
      header: "Kind",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: (t) => kindLabel(t.kind),
    },
    {
      key: "status",
      header: "Status",
      render: (t) => (
        <Badge tone={t.status === "active" ? "success" : "neutral"} dot>
          {t.status === "active" ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    ...(canRegistry
      ? ([
          {
            key: "actions",
            header: "Actions",
            align: "right",
            render: (t) => (
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setTheatreModal({ initial: t })}
                >
                  Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => retireTheatre(t)}>
                  {t.status === "active" ? "Retire" : "Reactivate"}
                </Button>
              </div>
            ),
          },
        ] as Column<Theatre>[])
      : []),
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Operation theatres</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            The day&rsquo;s surgical schedule and your theatre registry. Bookings that overlap on
            the same theatre are refused.
          </p>
        </div>
        {canSchedule && <Button onClick={() => setBooking(true)}>Book a procedure</Button>}
      </div>

      {error != null && <ErrorAlert error={error} fallback="Something went wrong." />}

      {/* ── OT board ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Schedule</h2>
          <input
            type="date"
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <DataTable<OtBooking>
          columns={bookingColumns}
          rows={sortedBookings}
          keyOf={(b) => b.id}
          loading={loading}
          empty="No procedures booked for this day."
          rowClassName={(b) => (b.status === "cancelled" ? "opacity-60" : "")}
        />
      </div>

      {/* ── Theatre registry ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Theatres</h2>
          {canRegistry && (
            <Button variant="secondary" size="sm" onClick={() => setTheatreModal({})}>
              Add theatre
            </Button>
          )}
        </div>
        <DataTable<Theatre>
          columns={theatreColumns}
          rows={theatres}
          keyOf={(t) => t.id}
          empty="No theatres yet."
          rowClassName={(t) => (t.status === "active" ? "" : "opacity-60")}
        />
      </div>

      {booking && (
        <BookingModal
          theatres={theatres}
          doctors={doctors}
          onClose={() => setBooking(false)}
          onBooked={() => {
            setBooking(false);
            loadBoard();
          }}
        />
      )}
      {theatreModal && (
        <TheatreModal
          initial={theatreModal.initial}
          onClose={() => setTheatreModal(null)}
          onSaved={() => {
            setTheatreModal(null);
            loadRefs();
          }}
        />
      )}
    </div>
  );
}

export default function Page() {
  return <TheatresPage />;
}
