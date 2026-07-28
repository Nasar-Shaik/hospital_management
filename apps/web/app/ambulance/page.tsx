"use client";

/**
 * Ambulance fleet — the dispatch board and the vehicle registry (Module B6).
 *
 * Two things on one screen: the BOARD (today's trips, each movable along its lifecycle) and the
 * REGISTRY (the vehicles a hospital runs). Dispatch rejects any window that overlaps another trip on
 * the same vehicle — the collision rule the API enforces.
 *
 * A trip does NOT require a patient: an emergency dispatch to a scene precedes registration, so the
 * form takes a free-text pickup and a contact number instead. Reading the board and the fleet needs
 * `ambulance:dispatch`; the registry needs `ambulance:manage`. The feature is gated on the ambulance
 * module edition flag.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  type Ambulance,
  type AmbulanceKind,
  type AmbulanceTrip,
  type AmbulanceTripStatus,
  type AmbulanceTripPurpose,
  type Patient,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Badge, Button, DataTable, Field, Modal, type Column } from "../../components/ui";
import { ErrorAlert } from "../../components/ui";

const AMBULANCE_KINDS: { value: AmbulanceKind; label: string }[] = [
  { value: "basic_life_support", label: "Basic life support (BLS)" },
  { value: "advanced_life_support", label: "Advanced life support (ALS)" },
  { value: "patient_transport", label: "Patient transport" },
  { value: "mortuary_van", label: "Mortuary van" },
];
const kindLabel = (k: AmbulanceKind) => AMBULANCE_KINDS.find((x) => x.value === k)?.label ?? k;

const TRIP_PURPOSES: { value: AmbulanceTripPurpose; label: string }[] = [
  { value: "emergency", label: "Emergency" },
  { value: "transfer", label: "Transfer" },
  { value: "discharge", label: "Discharge drop" },
  { value: "body_transport", label: "Body transport" },
  { value: "standby", label: "Standby" },
];
const purposeLabel = (p: AmbulanceTripPurpose) =>
  TRIP_PURPOSES.find((x) => x.value === p)?.label ?? p;

const STATUS_TONE: Record<AmbulanceTripStatus, "brand" | "warning" | "success" | "neutral"> = {
  dispatched: "brand",
  in_progress: "warning",
  completed: "success",
  cancelled: "neutral",
};

/** The legal next steps, mirroring the API's state machine — buttons only for what is allowed. */
const NEXT_STEPS: Record<AmbulanceTripStatus, { to: AmbulanceTripStatus; label: string }[]> = {
  dispatched: [
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
const todayStr = () => new Date().toISOString().slice(0, 10);

/* ── Dispatch form ── */

interface DispatchForm {
  ambulanceId: string;
  patientId: string;
  purpose: AmbulanceTripPurpose;
  pickup: string;
  dropoff: string;
  contactPhone: string;
  scheduledStart: string;
  scheduledEnd: string;
}

function DispatchModal({
  ambulances,
  onClose,
  onDispatched,
}: {
  ambulances: Ambulance[];
  onClose: () => void;
  onDispatched: () => void;
}) {
  const { api } = useAuth();
  const [f, setF] = useState<DispatchForm>({
    ambulanceId: "",
    patientId: "",
    purpose: "transfer",
    pickup: "",
    dropoff: "",
    contactPhone: "",
    scheduledStart: "",
    scheduledEnd: "",
  });
  const set = (patch: Partial<DispatchForm>) => setF((prev) => ({ ...prev, ...patch }));

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
      .createAmbulanceTrip({
        ambulanceId: f.ambulanceId,
        ...(f.patientId ? { patientId: f.patientId } : {}),
        purpose: f.purpose,
        ...(f.pickup.trim() ? { pickup: f.pickup.trim() } : {}),
        ...(f.dropoff.trim() ? { dropoff: f.dropoff.trim() } : {}),
        ...(f.contactPhone.trim() ? { contactPhone: f.contactPhone.trim() } : {}),
        scheduledStart: toIso(f.scheduledStart),
        scheduledEnd: toIso(f.scheduledEnd),
      })
      .then(() => onDispatched())
      .catch((err: unknown) => setError(err))
      .finally(() => setSaving(false));
  }

  const activeAmbulances = ambulances.filter((a) => a.status === "active");

  return (
    <Modal title="Dispatch an ambulance" onClose={onClose}>
      <form className="space-y-5" onSubmit={submit}>
        {error != null && <ErrorAlert error={error} fallback="Could not dispatch the ambulance." />}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Ambulance</span>
            <select
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
              value={f.ambulanceId}
              onChange={(e) => set({ ambulanceId: e.target.value })}
              required
            >
              <option value="">— Select a vehicle —</option>
              {activeAmbulances.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.code})
                </option>
              ))}
            </select>
          </label>

          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Purpose</span>
            <select
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
              value={f.purpose}
              onChange={(e) => set({ purpose: e.target.value as AmbulanceTripPurpose })}
            >
              {TRIP_PURPOSES.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Patient search-select — OPTIONAL. An emergency to a scene has no UHID yet. */}
        <div className="space-y-2">
          <span className="block text-sm font-medium text-[var(--color-fg)]">
            Patient <span className="font-normal text-[var(--color-fg-subtle)]">(optional)</span>
          </span>
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

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Pickup"
            name="pickup"
            value={f.pickup}
            onChange={(e) => set({ pickup: e.target.value })}
            placeholder="MG Road junction"
          />
          <Field
            label="Drop-off"
            name="dropoff"
            value={f.dropoff}
            onChange={(e) => set({ dropoff: e.target.value })}
            placeholder="Casualty"
          />
        </div>

        <Field
          label="Contact number"
          name="contactPhone"
          value={f.contactPhone}
          onChange={(e) => set({ contactPhone: e.target.value })}
          placeholder="Caller / attendant phone"
          hint="For a scene with no registered patient yet."
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
          <Button type="submit" loading={saving} disabled={!f.ambulanceId}>
            Dispatch
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Vehicle registry form ── */

function AmbulanceModal({
  initial,
  onClose,
  onSaved,
}: {
  initial?: Ambulance;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useAuth();
  const [name, setName] = useState(initial?.name ?? "");
  const [code, setCode] = useState(initial?.code ?? "");
  const [registrationNumber, setRegistrationNumber] = useState(initial?.registrationNumber ?? "");
  const [kind, setKind] = useState<AmbulanceKind>(initial?.kind ?? "basic_life_support");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const reg = registrationNumber.trim();
    const p = initial
      ? api.updateAmbulance(initial.id, {
          name: name.trim(),
          kind,
          ...(reg ? { registrationNumber: reg } : {}),
        })
      : api.createAmbulance({
          name: name.trim(),
          code: code.trim(),
          kind,
          ...(reg ? { registrationNumber: reg } : {}),
        });
    p.then(() => onSaved())
      .catch((err: unknown) => setError(err))
      .finally(() => setSaving(false));
  }

  return (
    <Modal title={initial ? `Edit ${initial.name}` : "Add ambulance"} onClose={onClose}>
      <form className="space-y-5" onSubmit={submit}>
        {error != null && <ErrorAlert error={error} fallback="Could not save the ambulance." />}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ambulance 1"
            required
          />
          <Field
            label="Code"
            name="code"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            disabled={!!initial}
            hint={initial ? "The code cannot change — records carry it." : "e.g. AMB1"}
            required
          />
          <Field
            label="Registration"
            name="registrationNumber"
            value={registrationNumber}
            onChange={(e) => setRegistrationNumber(e.target.value.toUpperCase())}
            placeholder="KA-01-AB-1234"
          />
          <label className="block text-sm">
            <span className="mb-1.5 block font-medium text-[var(--color-fg)]">Kind</span>
            <select
              className="w-full rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2 text-[var(--color-fg)]"
              value={kind}
              onChange={(e) => setKind(e.target.value as AmbulanceKind)}
            >
              {AMBULANCE_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex justify-end">
          <Button type="submit" loading={saving}>
            {initial ? "Save changes" : "Add ambulance"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function AmbulancePage() {
  const { api, can } = useAuth();
  const canDispatch = can("ambulance:dispatch");
  const canManage = can("ambulance:manage");

  const [ambulances, setAmbulances] = useState<Ambulance[]>([]);
  const [trips, setTrips] = useState<AmbulanceTrip[]>([]);
  const [date, setDate] = useState(todayStr());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const [dispatching, setDispatching] = useState(false);
  const [vehicleModal, setVehicleModal] = useState<{ initial?: Ambulance } | null>(null);

  const loadBoard = useCallback(() => {
    setLoading(true);
    const from = new Date(`${date}T00:00:00`);
    const to = new Date(`${date}T00:00:00`);
    to.setDate(to.getDate() + 1);
    api
      .listAmbulanceTrips({ from: from.toISOString(), to: to.toISOString() })
      .then(setTrips)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api, date]);

  const loadFleet = useCallback(() => {
    api
      .listAmbulances()
      .then(setAmbulances)
      .catch(() => undefined);
  }, [api]);

  useEffect(loadBoard, [loadBoard]);
  useEffect(loadFleet, [loadFleet]);

  function transition(t: AmbulanceTrip, to: AmbulanceTripStatus) {
    api
      .transitionAmbulanceTrip(t.id, { to })
      .then(() => loadBoard())
      .catch((e: unknown) => setError(e));
  }

  function retireVehicle(a: Ambulance) {
    api
      .updateAmbulance(a.id, { status: a.status === "active" ? "inactive" : "active" })
      .then(() => loadFleet())
      .catch((e: unknown) => setError(e));
  }

  const sortedTrips = useMemo(
    () => [...trips].sort((a, b) => a.scheduledStart.localeCompare(b.scheduledStart)),
    [trips],
  );

  const tripColumns: Column<AmbulanceTrip>[] = [
    {
      key: "time",
      header: "Time",
      cellClassName: "font-mono text-xs whitespace-nowrap text-[var(--color-fg-muted)]",
      render: (t) => `${fmtTime(t.scheduledStart)}–${fmtTime(t.scheduledEnd)}`,
    },
    {
      key: "vehicle",
      header: "Vehicle",
      cellClassName: "text-[var(--color-fg)]",
      render: (t) => t.ambulanceName,
    },
    {
      key: "purpose",
      header: "Purpose",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: (t) => purposeLabel(t.purpose),
    },
    {
      key: "who",
      header: "Patient / scene",
      render: (t) =>
        t.patientName ? (
          <>
            {t.patientName}{" "}
            <span className="font-mono text-xs text-[var(--color-fg-muted)]">{t.uhid}</span>
          </>
        ) : (
          <span className="text-[var(--color-fg-muted)]">{t.pickup ?? t.contactPhone ?? "—"}</span>
        ),
    },
    {
      key: "route",
      header: "Route",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: (t) => (t.pickup || t.dropoff ? `${t.pickup ?? "—"} → ${t.dropoff ?? "—"}` : "—"),
    },
    {
      key: "status",
      header: "Status",
      render: (t) => <Badge tone={STATUS_TONE[t.status]}>{t.status.replace("_", " ")}</Badge>,
    },
    ...(canDispatch
      ? ([
          {
            key: "actions",
            header: "Actions",
            align: "right",
            render: (t) => (
              <div className="flex justify-end gap-2">
                {NEXT_STEPS[t.status].map((step) => (
                  <Button
                    key={step.to}
                    size="sm"
                    variant={step.to === "cancelled" ? "ghost" : "secondary"}
                    onClick={() => transition(t, step.to)}
                  >
                    {step.label}
                  </Button>
                ))}
              </div>
            ),
          },
        ] as Column<AmbulanceTrip>[])
      : []),
  ];

  const vehicleColumns: Column<Ambulance>[] = [
    {
      key: "name",
      header: "Vehicle",
      cellClassName: "font-medium text-[var(--color-fg)]",
      render: (a) => a.name,
    },
    {
      key: "code",
      header: "Code",
      cellClassName: "font-mono text-xs text-[var(--color-fg-muted)]",
      render: (a) => a.code,
    },
    {
      key: "registration",
      header: "Registration",
      cellClassName: "font-mono text-xs text-[var(--color-fg-muted)]",
      render: (a) => a.registrationNumber ?? "—",
    },
    {
      key: "kind",
      header: "Kind",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: (a) => kindLabel(a.kind),
    },
    {
      key: "status",
      header: "Status",
      render: (a) => (
        <Badge tone={a.status === "active" ? "success" : "neutral"} dot>
          {a.status === "active" ? "Active" : "Inactive"}
        </Badge>
      ),
    },
    ...(canManage
      ? ([
          {
            key: "actions",
            header: "Actions",
            align: "right",
            render: (a) => (
              <div className="flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setVehicleModal({ initial: a })}
                >
                  Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => retireVehicle(a)}>
                  {a.status === "active" ? "Retire" : "Reactivate"}
                </Button>
              </div>
            ),
          },
        ] as Column<Ambulance>[])
      : []),
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Ambulance</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            The day&rsquo;s dispatch board and your vehicle registry. Trips that overlap on the same
            vehicle are refused.
          </p>
        </div>
        {canDispatch && <Button onClick={() => setDispatching(true)}>Dispatch</Button>}
      </div>

      {error != null && <ErrorAlert error={error} fallback="Something went wrong." />}

      {/* ── Dispatch board ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Trips</h2>
          <input
            type="date"
            className="rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm text-[var(--color-fg)]"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <DataTable<AmbulanceTrip>
          columns={tripColumns}
          rows={sortedTrips}
          keyOf={(t) => t.id}
          loading={loading}
          empty="No trips for this day."
          rowClassName={(t) => (t.status === "cancelled" ? "opacity-60" : "")}
        />
      </div>

      {/* ── Vehicle registry ── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">Fleet</h2>
          {canManage && (
            <Button variant="secondary" size="sm" onClick={() => setVehicleModal({})}>
              Add ambulance
            </Button>
          )}
        </div>
        <DataTable<Ambulance>
          columns={vehicleColumns}
          rows={ambulances}
          keyOf={(a) => a.id}
          empty="No ambulances yet."
          rowClassName={(a) => (a.status === "active" ? "" : "opacity-60")}
        />
      </div>

      {dispatching && (
        <DispatchModal
          ambulances={ambulances}
          onClose={() => setDispatching(false)}
          onDispatched={() => {
            setDispatching(false);
            loadBoard();
          }}
        />
      )}
      {vehicleModal && (
        <AmbulanceModal
          initial={vehicleModal.initial}
          onClose={() => setVehicleModal(null)}
          onSaved={() => {
            setVehicleModal(null);
            loadFleet();
          }}
        />
      )}
    </div>
  );
}

export default function Page() {
  return <AmbulancePage />;
}
