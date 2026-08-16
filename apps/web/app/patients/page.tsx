"use client";

/**
 * Patient registration & search (Doc 02 C1) — the front desk.
 *
 * ── THE ONE SCREEN THAT DECIDES DATA QUALITY FOREVER ─────────────────────────
 * Every duplicate chart in a hospital was created here, by a person under time
 * pressure with a queue behind them. So the duplicate check is not a validation
 * that fires on submit — it runs WHILE they type the name and phone, and the
 * candidates appear beside the form. A clerk who sees "Ramesh Kumar · UH000001 ·
 * same phone" before they have finished the address will click it, and that quiet
 * moment prevents more duplicates than any blocking dialog ever will.
 *
 * When the check comes back above the threshold, the API refuses (HMS-PAT-002)
 * and we show WHO it thinks this is and WHY — never a bare "duplicate detected".
 * A refusal a clerk cannot act on is a refusal they learn to route around.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  ApiClientError,
  type DuplicateCandidate,
  type Patient,
  type RegisterPatientInput,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Field,
  PermissionGate,
  type Column,
} from "../../components/ui";

/** One screenful of the register. The server caps a page at 100; 50 keeps the list scannable. */
const PAGE_SIZE = 50;

const EMPTY_FORM = {
  name: "",
  gender: "unknown",
  dob: "",
  bloodGroup: "",
  phone: "",
  email: "",
};

function age(dob?: string): string {
  if (!dob) return "—";
  const years = Math.floor((Date.now() - new Date(dob).getTime()) / 31_557_600_000);
  return `${years}y`;
}

/** The candidate list — the heart of the screen. Every row explains itself. */
function Candidates({
  candidates,
  blocking,
  onUse,
}: {
  candidates: DuplicateCandidate[];
  blocking: boolean;
  onUse: (patient: Patient) => void;
}) {
  if (candidates.length === 0) return null;

  return (
    <div
      className={`rounded-xl border p-4 ${
        blocking
          ? "border-[var(--color-warning)] bg-[var(--color-warning-bg)]"
          : "border-[var(--color-border)] bg-[var(--color-bg-subtle)]"
      }`}
    >
      <p className="text-sm font-medium text-[var(--color-fg)]">
        {blocking
          ? "This person may already be registered"
          : "Similar patients (not a match — just checking)"}
      </p>

      <ul className="mt-3 space-y-2">
        {candidates.map(({ patient, score, matchedOn }) => (
          <li
            key={patient.id}
            className="flex items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-elevated)] px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-[var(--color-fg)]">
                {patient.name}{" "}
                <span className="font-mono text-xs text-[var(--color-fg-muted)]">
                  {patient.uhid}
                </span>
              </p>
              <p className="text-xs text-[var(--color-fg-muted)]">
                {age(patient.dob)} · {patient.gender} · {patient.contact.phone ?? "no phone"} ·{" "}
                <span className="text-[var(--color-fg-subtle)]">
                  matched on {matchedOn.join(", ")} ({score})
                </span>
              </p>
            </div>
            <Button variant="secondary" onClick={() => onUse(patient)}>
              Use this patient
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const patientColumns: Column<Patient>[] = [
  {
    key: "uhid",
    header: "UHID",
    cellClassName: "font-mono text-xs text-[var(--color-fg-muted)] whitespace-nowrap",
    render: (p) => p.uhid,
  },
  {
    key: "name",
    header: "Name",
    cellClassName: "font-medium text-[var(--color-fg)]",
    render: (p) => p.name,
  },
  {
    key: "age",
    header: "Age / Gender",
    cellClassName: "text-[var(--color-fg-muted)] whitespace-nowrap",
    render: (p) => `${age(p.dob)} · ${p.gender}`,
  },
  {
    key: "phone",
    header: "Phone",
    cellClassName: "text-[var(--color-fg-muted)]",
    render: (p) => p.contact.phone ?? "—",
  },
  {
    key: "status",
    header: "Status",
    render: (p) => <Badge tone={p.status === "active" ? "success" : "neutral"}>{p.status}</Badge>,
  },
];

function Patients() {
  const { api, can } = useAuth();
  const router = useRouter();

  const [patients, setPatients] = useState<Patient[]>([]);
  const [query, setQuery] = useState("");
  /**
   * How many patients the search matches, against the page we hold.
   *
   * The list asked for 50 rows and rendered them with no page controls and no count, so a
   * hospital with more than 50 patients had a register that simply stopped — and, because the
   * screen said nothing, read as "that is everyone". Manual testing hit the same shape on the
   * lab's copy of this page.
   */
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);

  const [candidates, setCandidates] = useState<DuplicateCandidate[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [registered, setRegistered] = useState<Patient | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.listPatients({
        limit: PAGE_SIZE,
        page,
        ...(query ? { q: query } : {}),
      });
      setPatients(result.items);
      setTotal(result.meta.total ?? result.items.length);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load patients.");
    } finally {
      setLoading(false);
    }
  }, [api, query, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // A new search is a new register — page 2 of the old one is meaningless against it, and landing
  // on an empty page 2 reads as "no such patient".
  useEffect(() => {
    setPage(1);
  }, [query]);

  /**
   * The live duplicate check. Debounced, and deliberately fired on the fields that
   * actually identify a person — a keystroke in "address line 2" tells the MPI
   * nothing and should not cost a round trip.
   *
   * It is best-effort: if it fails, the clerk still registers, and the server's own
   * check (which is the one that counts) still refuses a duplicate. This is a hint,
   * not a gate. The gate is on the server, where it cannot be skipped.
   */
  useEffect(() => {
    if (!showForm || form.name.trim().length < 2) {
      setCandidates([]);
      setBlocked(false);
      return;
    }

    const timer = setTimeout(() => {
      void api
        .checkDuplicatePatients({
          name: form.name.trim(),
          ...(form.gender ? { gender: form.gender } : {}),
          ...(form.dob ? { dob: form.dob } : {}),
          ...(form.phone ? { phone: form.phone.trim() } : {}),
        })
        .then((found) => {
          setCandidates(found);
          setBlocked(found.some((c) => c.score >= 60));
        })
        .catch(() => {
          /* A failed hint must never block registration. The server still refuses duplicates. */
        });
    }, 350);

    return () => clearTimeout(timer);
  }, [api, showForm, form.name, form.gender, form.dob, form.phone]);

  function reset() {
    setForm(EMPTY_FORM);
    setCandidates([]);
    setBlocked(false);
    setFieldErrors({});
    setShowForm(false);
  }

  async function register(e: FormEvent, force = false) {
    e.preventDefault();
    setSaving(true);
    setFieldErrors({});
    setError(null);

    const input: RegisterPatientInput = {
      name: form.name.trim(),
      gender: form.gender as RegisterPatientInput["gender"],
      ...(form.dob ? { dob: form.dob } : {}),
      ...(form.bloodGroup ? { bloodGroup: form.bloodGroup } : {}),
      ...(form.phone || form.email
        ? {
            contact: {
              ...(form.phone ? { phone: form.phone.trim() } : {}),
              ...(form.email ? { email: form.email.trim() } : {}),
            },
          }
        : {}),
      ...(force ? { force: true } : {}),
    };

    try {
      const result = await api.registerPatient(input);
      setRegistered(result.patient);
      reset();
      await load();
    } catch (err) {
      if (err instanceof ApiClientError) {
        // HMS-PAT-002 — the MPI refused. Show who it thinks this is, and let a
        // permitted user override. Do NOT retry with force automatically.
        if (err.code === "HMS-PAT-002") {
          const details = err.details as { candidates?: DuplicateCandidate[] } | undefined;
          const raw = details?.candidates ?? [];
          // The API's 409 payload is flattened; re-shape it for the same component.
          setCandidates(
            raw.map((c: unknown) => {
              const row = c as Patient & { score: number; matchedOn: string[] };
              return { patient: row, score: row.score, matchedOn: row.matchedOn };
            }),
          );
          setBlocked(true);
          setError(null);
        } else {
          if (err.fieldErrors) setFieldErrors(err.fieldErrors);
          setError(err.message);
        }
      } else {
        setError("Could not register the patient.");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Patients</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            One patient, one UHID — for life.
          </p>
        </div>
        <PermissionGate can={can} permission="patient:register">
          <Button onClick={() => (showForm ? reset() : setShowForm(true))}>
            {showForm ? "Cancel" : "Register patient"}
          </Button>
        </PermissionGate>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {registered && (
        <Alert tone="success">
          <span>
            Registered <strong>{registered.name}</strong> as{" "}
            <code className="rounded-md bg-[var(--color-bg-elevated)] px-2 py-0.5 font-mono">
              {registered.uhid}
            </code>{" "}
            — this is their number for life.
          </span>
        </Alert>
      )}

      {showForm && (
        <Card>
          <form onSubmit={(e) => void register(e)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Full name"
                required
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                {...(fieldErrors.name?.[0] ? { error: fieldErrors.name[0] } : {})}
              />
              <Field
                label="Phone"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                {...(fieldErrors["contact.phone"]?.[0]
                  ? { error: fieldErrors["contact.phone"][0] }
                  : {})}
              />
              <Field
                label="Date of birth"
                type="date"
                value={form.dob}
                onChange={(e) => setForm((f) => ({ ...f, dob: e.target.value }))}
                {...(fieldErrors.dob?.[0] ? { error: fieldErrors.dob[0] } : {})}
              />
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">
                  Gender
                </span>
                <select
                  value={form.gender}
                  onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value }))}
                  className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)]"
                >
                  <option value="unknown">Unknown</option>
                  <option value="male">Male</option>
                  <option value="female">Female</option>
                  <option value="other">Other</option>
                </select>
              </label>
            </div>

            {/*
              Only the NAME is required. An unconscious patient from a road accident
              has no date of birth, no phone and no name they can give — and a form
              that cannot describe them is a form the emergency department bypasses
              on paper (BUSINESS_WORKFLOWS §1).
            */}
            <p className="text-xs text-[var(--color-fg-subtle)]">
              Only a name is required. An emergency patient can be registered with nothing else and
              reconciled later.
            </p>

            <Candidates
              candidates={candidates}
              blocking={blocked}
              onUse={(patient) => {
                reset();
                setQuery(patient.uhid);
              }}
            />

            <div className="flex gap-2">
              <Button type="submit" disabled={saving || blocked}>
                {saving ? "Registering…" : "Register"}
              </Button>

              {/*
                The override. Visible only to someone holding `patient:merge` — the
                permission that says this person is trusted to decide two people are
                different. The server enforces it again regardless; this only stops
                us showing a button that would 403 (Constitution §3.6).
              */}
              {blocked && can("patient:merge") && (
                <Button
                  variant="secondary"
                  disabled={saving}
                  onClick={(e) => void register(e as unknown as FormEvent, true)}
                >
                  This is a different person — register anyway
                </Button>
              )}
            </div>
          </form>
        </Card>
      )}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by UHID, name or phone…"
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]"
      />

      <DataTable<Patient>
        columns={patientColumns}
        rows={loading ? [] : patients}
        keyOf={(p) => p.id}
        loading={loading}
        empty={query ? "No patient matches that." : "No patients yet."}
        onRowClick={(p) => router.push(`/patients/${p.id}`)}
      />

      {/*
        The count first, the controls second. "1–50 of 812" is the sentence that was missing:
        without it a full page and a complete register look identical, and a clerk who cannot find
        someone has no way to tell whether they are absent or merely on page four.
      */}
      {!loading && total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-[var(--color-fg-muted)]">
            {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of{" "}
            <span className="font-medium text-[var(--color-fg)]">{total}</span>
            {query ? " matching" : ""}
          </p>

          {total > PAGE_SIZE && (
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                disabled={page === 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <Button
                variant="secondary"
                disabled={page * PAGE_SIZE >= total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function PatientsPage() {
  return <Patients />;
}
