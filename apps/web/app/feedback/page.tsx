"use client";

/**
 * Feedback & complaints (Module B10).
 *
 * One register for the two things a patient tells the hospital about itself — a compliment/
 * suggestion and a grievance. The desk logs them (`feedback:manage`) and works complaints through a
 * lifecycle to a resolution (`complaint:manage`). A complaint that is logged and never worked is
 * worse than none, so the board leads with what is open and unassigned.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  type FeedbackTicket,
  type FeedbackKind,
  type FeedbackCategory,
  type FeedbackChannel,
  type ComplaintSeverity,
  type FeedbackStatus,
  type StaffMember,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Badge, Button, Card, Field, ErrorAlert } from "../../components/ui";

const CATEGORIES: { value: FeedbackCategory; label: string }[] = [
  { value: "service", label: "Service" },
  { value: "staff", label: "Staff" },
  { value: "billing", label: "Billing" },
  { value: "cleanliness", label: "Cleanliness" },
  { value: "food", label: "Food" },
  { value: "waiting_time", label: "Waiting time" },
  { value: "clinical", label: "Clinical" },
  { value: "facilities", label: "Facilities" },
  { value: "other", label: "Other" },
];
const CHANNELS: { value: FeedbackChannel; label: string }[] = [
  { value: "in_person", label: "In person" },
  { value: "phone", label: "Phone" },
  { value: "email", label: "Email" },
  { value: "web", label: "Web" },
  { value: "suggestion_box", label: "Suggestion box" },
  { value: "other", label: "Other" },
];
const label = <T extends string>(list: { value: T; label: string }[], v: T): string =>
  list.find((x) => x.value === v)?.label ?? v;

const STATUS_META: Record<
  FeedbackStatus,
  { label: string; tone: "neutral" | "brand" | "warning" | "success" }
> = {
  open: { label: "Open", tone: "brand" },
  in_progress: { label: "In progress", tone: "warning" },
  resolved: { label: "Resolved", tone: "success" },
  closed: { label: "Closed", tone: "neutral" },
};

const SEVERITY_META: Record<
  ComplaintSeverity,
  { label: string; tone: "neutral" | "warning" | "danger" }
> = {
  low: { label: "Low", tone: "neutral" },
  medium: { label: "Medium", tone: "warning" },
  high: { label: "High", tone: "danger" },
};

/** The lifecycle, mirrored from the server so the detail view offers only legal moves. */
const TRANSITIONS: Record<FeedbackStatus, FeedbackStatus[]> = {
  open: ["in_progress", "resolved", "closed"],
  in_progress: ["resolved", "closed"],
  resolved: ["closed", "in_progress"],
  closed: [],
};
const TRANSITION_LABEL: Record<FeedbackStatus, string> = {
  open: "Reopen",
  in_progress: "Start work",
  resolved: "Resolve",
  closed: "Close",
};

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* ── shared bits ───────────────────────────────────────────────────────────── */

function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className={`w-full ${wide ? "max-w-2xl" : "max-w-lg"} rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-xl`}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3.5">
          <h2 className="font-semibold text-[var(--color-fg)]">{title}</h2>
          <button
            onClick={onClose}
            className="text-[var(--color-fg-subtle)] hover:text-[var(--color-fg)]"
            aria-label="Close"
          >
            ✕
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

function Select({
  label: lbl,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{lbl}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/30"
      >
        {children}
      </select>
    </label>
  );
}

function Textarea({
  label: lbl,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{lbl}</span>
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm outline-none transition-colors focus:border-[var(--color-brand-500)] focus:ring-2 focus:ring-[var(--color-brand-500)]/30"
      />
    </label>
  );
}

/* ── create form ───────────────────────────────────────────────────────────── */

function CreateForm({
  onSubmit,
  saving,
  error,
}: {
  onSubmit: (v: Parameters<ReturnType<typeof useAuth>["api"]["createFeedback"]>[0]) => void;
  saving: boolean;
  error?: unknown;
}) {
  const [kind, setKind] = useState<FeedbackKind>("complaint");
  const [category, setCategory] = useState<FeedbackCategory>("service");
  const [channel, setChannel] = useState<FeedbackChannel>("in_person");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [reporterName, setReporterName] = useState("");
  const [reporterPhone, setReporterPhone] = useState("");
  const [severity, setSeverity] = useState<ComplaintSeverity>("medium");
  const [rating, setRating] = useState("5");

  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit({
          kind,
          category,
          channel,
          subject: subject.trim(),
          description: description.trim(),
          ...(reporterName.trim() ? { reporterName: reporterName.trim() } : {}),
          ...(reporterPhone.trim() ? { reporterPhone: reporterPhone.trim() } : {}),
          ...(kind === "complaint" ? { severity } : { rating: Number(rating) }),
        });
      }}
    >
      {error != null && <ErrorAlert error={error} fallback="Could not log this." />}
      <div className="grid grid-cols-2 gap-3">
        <Select label="Type" value={kind} onChange={(v) => setKind(v as FeedbackKind)}>
          <option value="complaint">Complaint</option>
          <option value="feedback">Feedback / compliment</option>
        </Select>
        <Select
          label="Category"
          value={category}
          onChange={(v) => setCategory(v as FeedbackCategory)}
        >
          {CATEGORIES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
        <Select label="Channel" value={channel} onChange={(v) => setChannel(v as FeedbackChannel)}>
          {CHANNELS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </Select>
        {kind === "complaint" ? (
          <Select
            label="Severity"
            value={severity}
            onChange={(v) => setSeverity(v as ComplaintSeverity)}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </Select>
        ) : (
          <Select label="Rating" value={rating} onChange={setRating}>
            {[5, 4, 3, 2, 1].map((r) => (
              <option key={r} value={r}>
                {r} ★
              </option>
            ))}
          </Select>
        )}
      </div>
      <Field
        label="Subject"
        name="subject"
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        placeholder="Short summary"
        required
      />
      <Textarea
        label="Details"
        value={description}
        onChange={setDescription}
        placeholder="What happened, in the reporter's words"
        rows={4}
      />
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Reporter name"
          name="reporterName"
          value={reporterName}
          onChange={(e) => setReporterName(e.target.value)}
          placeholder="Patient / visitor"
        />
        <Field
          label="Reporter phone"
          name="reporterPhone"
          value={reporterPhone}
          onChange={(e) => setReporterPhone(e.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <Button type="submit" loading={saving}>
          Log {kind === "complaint" ? "complaint" : "feedback"}
        </Button>
      </div>
    </form>
  );
}

/* ── detail / work view ────────────────────────────────────────────────────── */

function TicketDetail({
  ticket,
  staff,
  staffName,
  canResolve,
  onChanged,
}: {
  ticket: FeedbackTicket;
  staff: StaffMember[];
  staffName: (id?: string) => string;
  canResolve: boolean;
  onChanged: () => void;
}) {
  const { api } = useAuth();
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState(ticket.assignedTo ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNote("");
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const st = STATUS_META[ticket.status];
  const moves = TRANSITIONS[ticket.status];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={ticket.kind === "complaint" ? "warning" : "brand"}>
          {ticket.kind === "complaint" ? "Complaint" : "Feedback"}
        </Badge>
        <Badge tone="neutral">{label(CATEGORIES, ticket.category)}</Badge>
        {ticket.severity && (
          <Badge tone={SEVERITY_META[ticket.severity].tone}>
            {SEVERITY_META[ticket.severity].label} severity
          </Badge>
        )}
        {ticket.rating != null && <Badge tone="success">{ticket.rating} ★</Badge>}
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>

      <p className="text-sm whitespace-pre-wrap text-[var(--color-fg)]">{ticket.description}</p>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--color-fg-muted)]">
        <div>
          <dt className="inline text-[var(--color-fg-subtle)]">Reporter: </dt>
          <dd className="inline">{ticket.reporterName ?? "—"}</dd>
        </div>
        <div>
          <dt className="inline text-[var(--color-fg-subtle)]">Phone: </dt>
          <dd className="inline">{ticket.reporterPhone ?? "—"}</dd>
        </div>
        <div>
          <dt className="inline text-[var(--color-fg-subtle)]">Channel: </dt>
          <dd className="inline">{label(CHANNELS, ticket.channel)}</dd>
        </div>
        <div>
          <dt className="inline text-[var(--color-fg-subtle)]">Logged: </dt>
          <dd className="inline">{fmtDateTime(ticket.createdAt)}</dd>
        </div>
        <div>
          <dt className="inline text-[var(--color-fg-subtle)]">Assigned: </dt>
          <dd className="inline">
            {ticket.assignedTo ? staffName(ticket.assignedTo) : "Unassigned"}
          </dd>
        </div>
      </dl>

      {ticket.resolutionNote && (
        <div className="rounded-lg border border-[var(--color-success)]/30 bg-[var(--color-success-bg)] p-3 text-sm">
          <span className="font-medium text-[var(--color-fg)]">Resolution: </span>
          <span className="text-[var(--color-fg-muted)]">{ticket.resolutionNote}</span>
        </div>
      )}

      {/* Timeline */}
      {ticket.statusHistory.length > 0 && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-[var(--color-fg-muted)] uppercase">
            History
          </h3>
          <ul className="space-y-1 text-xs text-[var(--color-fg-muted)]">
            {ticket.statusHistory.map((h, i) => (
              <li key={i} className="flex flex-wrap gap-1">
                <span className="text-[var(--color-fg)]">
                  {STATUS_META[h.from].label} → {STATUS_META[h.to].label}
                </span>
                <span>· {fmtDateTime(h.at)}</span>
                {h.by && <span>· {staffName(h.by)}</span>}
                {h.note && <span className="text-[var(--color-fg-subtle)]">· {h.note}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {canResolve && (
        <div className="space-y-3 border-t border-[var(--color-border)] pt-4">
          {error != null && <ErrorAlert error={error} fallback="Could not update the ticket." />}

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <Select label="Assign to" value={assignee} onChange={setAssignee}>
                <option value="">Unassigned</option>
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </div>
            <Button
              variant="secondary"
              loading={busy}
              onClick={() => void run(() => api.assignFeedback(ticket.id, assignee || null))}
            >
              Save
            </Button>
          </div>

          {moves.length > 0 && (
            <>
              <Textarea
                label="Note (required to resolve)"
                value={note}
                onChange={setNote}
                placeholder="What was done / why"
                rows={2}
              />
              <div className="flex flex-wrap gap-2">
                {moves.map((to) => (
                  <Button
                    key={to}
                    variant={to === "resolved" ? "primary" : "ghost"}
                    loading={busy}
                    onClick={() =>
                      void run(() =>
                        api.transitionFeedback(ticket.id, {
                          to,
                          ...(note.trim() ? { note: note.trim() } : {}),
                        }),
                      )
                    }
                  >
                    {TRANSITION_LABEL[to]}
                  </Button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ── page ──────────────────────────────────────────────────────────────────── */

function FeedbackPage() {
  const { api, can } = useAuth();
  const canResolve = can("complaint:manage");
  const [tickets, setTickets] = useState<FeedbackTicket[]>([]);
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [kindFilter, setKindFilter] = useState<"" | FeedbackKind>("");
  const [statusFilter, setStatusFilter] = useState<"" | FeedbackStatus>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<unknown>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .listFeedback({
        ...(kindFilter ? { kind: kindFilter } : {}),
        ...(statusFilter ? { status: statusFilter } : {}),
      })
      .then(setTickets)
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api, kindFilter, statusFilter]);
  useEffect(load, [load]);

  // The staff list drives assignment + name display. It needs `user:read`; a desk that only holds
  // `feedback:manage` will 403 here, so we fail soft — ids simply show unresolved.
  useEffect(() => {
    api
      .listStaff({ limit: 200 })
      .then((p) => setStaff(p.items))
      .catch(() => setStaff([]));
  }, [api]);

  const staffById = useMemo(() => new Map(staff.map((s) => [s.id, s.name])), [staff]);
  const staffName = (id?: string) => (id ? (staffById.get(id) ?? "Staff member") : "—");

  const openTicket = tickets.find((t) => t.id === openId) ?? null;
  const openCount = tickets.filter((t) => t.status === "open").length;

  async function create(input: Parameters<typeof api.createFeedback>[0]) {
    setSaving(true);
    setFormError(null);
    try {
      await api.createFeedback(input);
      setCreating(false);
      load();
    } catch (e) {
      setFormError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">
            Feedback &amp; complaints
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            What patients tell us, and what we did about it.
            {openCount > 0 && (
              <span className="ml-1 text-[var(--color-brand-600)]">{openCount} open.</span>
            )}
          </p>
        </div>
        <Button
          onClick={() => {
            setFormError(null);
            setCreating(true);
          }}
        >
          Log new
        </Button>
      </div>

      <Card className="flex flex-wrap gap-3 p-4">
        <div className="min-w-40">
          <Select
            label="Type"
            value={kindFilter}
            onChange={(v) => setKindFilter(v as "" | FeedbackKind)}
          >
            <option value="">All types</option>
            <option value="complaint">Complaints</option>
            <option value="feedback">Feedback</option>
          </Select>
        </div>
        <div className="min-w-40">
          <Select
            label="Status"
            value={statusFilter}
            onChange={(v) => setStatusFilter(v as "" | FeedbackStatus)}
          >
            <option value="">All statuses</option>
            {(["open", "in_progress", "resolved", "closed"] as FeedbackStatus[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
              </option>
            ))}
          </Select>
        </div>
      </Card>

      {error != null && <ErrorAlert error={error} fallback="Could not load the register." />}

      {loading ? (
        <p className="py-8 text-center text-sm text-[var(--color-fg-muted)]">Loading…</p>
      ) : tickets.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="text-sm text-[var(--color-fg-muted)]">Nothing logged yet.</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {tickets.map((t) => {
            const st = STATUS_META[t.status];
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setOpenId(t.id)}
                className="flex w-full flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-4 text-left shadow-[var(--shadow-xs)] transition-colors hover:border-[var(--color-brand-500)]/40"
              >
                <div className="min-w-40 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={t.kind === "complaint" ? "warning" : "brand"}>
                      {t.kind === "complaint" ? "Complaint" : "Feedback"}
                    </Badge>
                    <span className="font-medium text-[var(--color-fg)]">{t.subject}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-[var(--color-fg-subtle)]">
                    {label(CATEGORIES, t.category)} · {t.reporterName ?? "Anonymous"} ·{" "}
                    {fmtDateTime(t.createdAt)}
                  </p>
                </div>
                {t.severity && (
                  <Badge tone={SEVERITY_META[t.severity].tone}>
                    {SEVERITY_META[t.severity].label}
                  </Badge>
                )}
                {t.rating != null && <Badge tone="success">{t.rating} ★</Badge>}
                <span className="text-xs text-[var(--color-fg-muted)]">
                  {t.assignedTo ? staffName(t.assignedTo) : "Unassigned"}
                </span>
                <Badge tone={st.tone}>{st.label}</Badge>
              </button>
            );
          })}
        </div>
      )}

      {creating && (
        <Modal title="Log feedback or complaint" onClose={() => setCreating(false)}>
          <CreateForm onSubmit={create} saving={saving} error={formError} />
        </Modal>
      )}
      {openTicket && (
        <Modal title={openTicket.subject} onClose={() => setOpenId(null)} wide>
          <TicketDetail
            ticket={openTicket}
            staff={staff}
            staffName={staffName}
            canResolve={canResolve}
            onChanged={load}
          />
        </Modal>
      )}
    </div>
  );
}

export default function Page() {
  return <FeedbackPage />;
}
