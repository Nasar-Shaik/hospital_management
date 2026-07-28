"use client";

/**
 * The operator console (Doc 02 A1).
 *
 * One job: see every hospital, create a new one with its administrator, change what a hospital pays,
 * configure its tenure and estate, and take one offline when you must. A console that buries these
 * behind navigation is a console nobody can use at 2am when a customer is locked out.
 *
 * ── NO BROWSER DIALOGS ──────────────────────────────────────────────────────
 * Every configuration action used to be a `window.prompt` / `window.confirm`. Those are unstyled,
 * un-brandable, and impossible to validate as the operator types. They are gone: a click on a
 * hospital opens a DETAIL DRAWER with proper forms, and the one destructive action (suspend) asks
 * with an in-app confirmation, not the browser's.
 *
 * What is NOT here, and must never be: any view of patient data. An operator manages the container.
 * The contents belong to the hospital.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiClientError,
  type Edition,
  type Hospital,
  type HospitalDetail,
} from "@medicore/api-client";
import { ThemeToggle } from "@medicore/ui";
import { OperatorProvider, useOperator } from "../lib/operator";
import { Badge, Button, ConfirmDialog, Drawer, Field, Modal } from "../components/ui";

function statusTone(status: Hospital["status"]): "success" | "warning" | "danger" | "neutral" {
  if (status === "active") return "success";
  if (status === "trial") return "warning";
  if (status === "suspended") return "danger";
  return "neutral";
}

/** Tone + human label for a hospital's licence state (ADR-0016). */
function licenseBadge(license: Hospital["license"]): {
  tone: "success" | "warning" | "danger" | "neutral";
  label: string;
} {
  const days = license.daysRemaining;
  const on = (n: number | null) => (n == null ? "" : ` · ${String(n)}d`);
  switch (license.state) {
    case "PERPETUAL":
      return { tone: "neutral", label: "Perpetual" };
    case "EXPIRED":
      return { tone: "danger", label: "Expired" };
    case "GRACE":
      return { tone: "danger", label: `Grace${on(days)}` };
    default:
      return days != null && days <= 10
        ? { tone: "warning", label: `Expiring${on(days)}` }
        : { tone: "success", label: `Active${on(days)}` };
  }
}

function shortDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** The plain-language "when does this hospital stop working" line for the drawer. */
function licenseExpiry(license: Hospital["license"]): string {
  if (license.state === "PERPETUAL") return "No expiry — perpetual licence";
  const d = license.daysRemaining;
  const on = shortDate(license.expiresAt);
  const plural = (n: number) => (Math.abs(n) === 1 ? "day" : "days");
  if (license.state === "EXPIRED")
    return d != null
      ? `Expired ${Math.abs(d)} ${plural(d)} ago — was ${on}`
      : `Expired — was ${on}`;
  if (license.state === "GRACE")
    return d != null
      ? `In grace period · ${d} ${plural(d)} of grace left — expired ${on}`
      : `In grace period — expired ${on}`;
  return d != null ? `Expires ${on} · ${d} ${plural(d)} remaining` : `Expires ${on}`;
}

/**
 * School-ERP-style renewal presets. Extending counts from the LATER of today or the current expiry
 * (see the API), so these read as "add this much tenure" rather than "expire this far from now".
 */
const EXTEND_PRESETS: { label: string; days: number }[] = [
  { label: "1 month", days: 30 },
  { label: "3 months", days: 90 },
  { label: "6 months", days: 180 },
  { label: "1 year", days: 365 },
];

/** Where a licence would land if extended by `addDays` today (mirrors the API's later-of rule). */
function projectedExpiry(license: Hospital["license"], addDays: number): string {
  const now = Date.now();
  const base =
    license.expiresAt && new Date(license.expiresAt).getTime() > now
      ? new Date(license.expiresAt).getTime()
      : now;
  return shortDate(new Date(base + addDays * 86_400_000).toISOString());
}

/* ── login ────────────────────────────────────────────────────────────────── */

function OperatorLogin() {
  const { login } = useOperator();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      // One message for every failure — the operator list is short and valuable; this form must
      // not become a way to discover who works here.
      setError(
        err instanceof ApiClientError
          ? "Incorrect email or password."
          : "Could not reach the platform API.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[var(--color-bg-subtle)] px-4">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl text-lg font-bold text-[var(--color-on-accent)] shadow-[var(--shadow-sm)]"
            style={{ background: "var(--gradient-brand)" }}
          >
            P
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-[var(--color-fg)]">
            Operator console
          </h1>
          <p className="mt-1 text-sm text-[var(--color-fg-subtle)]">
            PaperlessTech platform — staff only.
          </p>
        </div>

        <div className="space-y-4 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-6 shadow-[var(--shadow-lg)]">
          {error && (
            <p className="rounded-lg bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]">
              {error}
            </p>
          )}
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <Button type="submit" loading={busy} className="w-full">
            Sign in
          </Button>
        </div>
      </form>
    </main>
  );
}

/* ── tenant detail + configuration drawer ────────────────────────────────────── */

type Created = { hospital: Hospital; email: string; password?: string };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="shrink-0 text-sm text-[var(--color-fg-muted)]">{label}</dt>
      <dd className="min-w-0 text-right text-sm font-medium text-[var(--color-fg)]">{children}</dd>
    </div>
  );
}

/** One self-contained config action: a labelled control with its own Apply button + feedback. */
function ConfigBlock({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-border)] p-4">
      <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
      {hint && <p className="mt-0.5 text-xs text-[var(--color-fg-muted)]">{hint}</p>}
      <div className="mt-3">{children}</div>
    </div>
  );
}

function TenantDrawer({
  hospital,
  editions,
  isSuperAdmin,
  onClose,
  onChanged,
  onIssued,
}: {
  hospital: Hospital;
  editions: Edition[];
  isSuperAdmin: boolean;
  onClose: () => void;
  onChanged: () => void;
  onIssued: (c: Created) => void;
}) {
  const { api } = useOperator();
  const [detail, setDetail] = useState<HospitalDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmSuspend, setConfirmSuspend] = useState(false);
  // The drawer opens in VIEW mode (a prefilled, read-only record); the operator clicks Edit to
  // configure. The two states keep a routine "just checking on them" from ever being a mis-click
  // away from re-pricing a hospital.
  const [editing, setEditing] = useState(false);

  // Editable fields, seeded from the row and re-seeded when the detail loads.
  const [branches, setBranches] = useState(String(hospital.maxBranches ?? 1));
  const [domain, setDomain] = useState(hospital.customDomain ?? "");
  const [extendDays, setExtendDays] = useState("365");
  const [adminEmail, setAdminEmail] = useState("");

  const reload = useCallback(async () => {
    try {
      const d = await api.getHospital(hospital.id);
      setDetail(d);
      setBranches(String(d.maxBranches ?? 1));
      setDomain(d.customDomain ?? "");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the hospital.");
    }
  }, [api, hospital.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await reload();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  const h = detail ?? hospital;
  const lic = licenseBadge(h.license);

  return (
    <Drawer
      title={h.hospitalName}
      subtitle={
        <a href={h.url} target="_blank" rel="noreferrer" className="font-mono text-xs underline">
          {h.url}
        </a>
      }
      onClose={onClose}
    >
      <div className="space-y-6">
        {error && (
          <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {/* View ⇄ Edit toggle — configuration is hidden until the operator asks to change it. */}
        {isSuperAdmin && (
          <div className="flex items-center justify-between">
            <span className="text-xs text-[var(--color-fg-muted)]">
              {editing ? "Editing configuration" : "Viewing details"}
            </span>
            <Button
              variant={editing ? "secondary" : "primary"}
              size="sm"
              onClick={() => setEditing((v) => !v)}
            >
              {editing ? "Done" : "Edit configuration"}
            </Button>
          </div>
        )}

        {/* Overview */}
        <dl className="divide-y divide-[var(--color-border)] rounded-xl border border-[var(--color-border)] px-4">
          <Row label="Status">
            <Badge tone={statusTone(h.status)} dot>
              {h.status}
            </Badge>
          </Row>
          <Row label="Licence">
            <div className="flex flex-col items-end gap-1">
              <Badge tone={lic.tone}>{lic.label}</Badge>
              <span className="text-xs text-[var(--color-fg-muted)]">
                {licenseExpiry(h.license)}
              </span>
            </div>
          </Row>
          <Row label="Edition">{h.planCode ?? "—"}</Row>
          <Row label="Supported branches">{h.maxBranches ?? 1}</Row>
          {h.customDomain && <Row label="Custom domain">{h.customDomain}</Row>}
          <Row label="Database">
            <span className="font-mono text-xs text-[var(--color-fg-muted)]">{h.databaseName}</span>
          </Row>
        </dl>

        {/* Usage meters (real data) */}
        {detail && detail.usage.length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
              Usage
            </p>
            <div className="space-y-2.5 rounded-xl border border-[var(--color-border)] p-4">
              {detail.usage.map((u) => {
                const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 0;
                const barTone = u.exceeded
                  ? "bg-[var(--color-danger)]"
                  : u.warning
                    ? "bg-[var(--color-warning)]"
                    : "bg-[var(--color-brand-600)]";
                return (
                  <div key={u.metric}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-[var(--color-fg-muted)] capitalize">
                        {u.metric.replace(/_/g, " ")}
                      </span>
                      <span className="font-medium tabular-nums text-[var(--color-fg)]">
                        {u.used}
                        {u.limit != null ? ` / ${u.limit}` : ""}
                      </span>
                    </div>
                    {u.limit != null && (
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--color-bg-subtle)]">
                        <div
                          className={`h-full rounded-full ${barTone}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Configuration — super admin only, and only once they have clicked Edit. */}
        {isSuperAdmin && editing && (
          <div className="space-y-3">
            <p className="text-xs font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
              Configuration
            </p>

            <ConfigBlock
              title="Edition"
              hint="Changes what this hospital may use. A downgrade is refused if they exceed the new limits."
            >
              <select
                value={h.planCode ?? ""}
                onChange={(e) =>
                  void run("plan", () => api.setHospitalPlan(hospital.id, e.target.value))
                }
                disabled={busy === "plan"}
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm"
              >
                <option value="">— none —</option>
                {editions.map((ed) => (
                  <option key={ed.code} value={ed.code}>
                    {ed.name}
                  </option>
                ))}
              </select>
            </ConfigBlock>

            <ConfigBlock
              title="Extend licence"
              hint="Counts from the later of today or the current expiry, so it never shortens an active licence."
            >
              <div className="space-y-3">
                {/* Preset terms — the quick, unambiguous choices an operator reaches for. */}
                <div className="flex flex-wrap gap-2">
                  {EXTEND_PRESETS.map((p) => {
                    const selected = extendDays === String(p.days);
                    return (
                      <button
                        key={p.days}
                        type="button"
                        onClick={() => setExtendDays(String(p.days))}
                        className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                          selected
                            ? "border-[var(--color-brand-600)] bg-[var(--color-brand-50)] text-[var(--color-brand-700)]"
                            : "border-[var(--color-border-strong)] text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
                        }`}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                </div>

                {/* Custom term, for the renewal that does not fit a preset. */}
                <label className="flex items-center gap-2 text-sm text-[var(--color-fg-muted)]">
                  <span>Custom</span>
                  <input
                    type="number"
                    min={1}
                    value={extendDays}
                    onChange={(e) => setExtendDays(e.target.value)}
                    className="w-24 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm"
                  />
                  <span>days</span>
                </label>

                {/* Live preview — the operator sees the new expiry BEFORE committing. */}
                {(() => {
                  const days = Number(extendDays.trim());
                  const valid = Number.isFinite(days) && days >= 1;
                  return (
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs text-[var(--color-fg-subtle)]">
                        {valid ? (
                          <>
                            New expiry:{" "}
                            <span className="font-medium text-[var(--color-fg)]">
                              {projectedExpiry(h.license, days)}
                            </span>
                          </>
                        ) : (
                          "Pick a term or enter a number of days."
                        )}
                      </p>
                      <Button
                        variant="primary"
                        size="sm"
                        loading={busy === "licence"}
                        onClick={() => {
                          if (!valid) {
                            setError("Enter a whole number of days (1 or more).");
                            return;
                          }
                          void run("licence", () =>
                            api.setHospitalLicense(hospital.id, { extendDays: days }),
                          );
                        }}
                      >
                        Extend
                      </Button>
                    </div>
                  );
                })()}
              </div>
            </ConfigBlock>

            <ConfigBlock
              title="Supported branches"
              hint="Lowering this does not delete branches — it just stops new ones until raised again."
            >
              <div className="flex gap-2">
                <input
                  type="number"
                  min={1}
                  value={branches}
                  onChange={(e) => setBranches(e.target.value)}
                  className="w-28 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === "branches"}
                  onClick={() => {
                    const n = Number(branches.trim());
                    if (!Number.isFinite(n) || n < 1) {
                      setError("Supported branches must be a whole number of at least 1.");
                      return;
                    }
                    void run("branches", () => api.setHospitalLimits(hospital.id, n));
                  }}
                >
                  Save
                </Button>
              </div>
            </ConfigBlock>

            <ConfigBlock
              title="Custom domain"
              hint="A bare hostname that resolves to this hospital. Clear the box to detach. DNS/TLS is set up separately."
            >
              <div className="flex gap-2">
                <input
                  value={domain}
                  onChange={(e) => setDomain(e.target.value.toLowerCase())}
                  placeholder="care.hospital.com"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 font-mono text-sm"
                />
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === "domain"}
                  onClick={() => {
                    const d = domain.trim().toLowerCase();
                    void run("domain", () =>
                      api.setHospitalDomain(hospital.id, d === "" ? null : d),
                    );
                  }}
                >
                  Save
                </Button>
              </div>
            </ConfigBlock>

            <ConfigBlock
              title="Issue an administrator"
              hint="Creates a fresh admin login for this hospital — the temporary password is shown once."
            >
              <div className="flex gap-2">
                <input
                  type="email"
                  value={adminEmail}
                  onChange={(e) => setAdminEmail(e.target.value)}
                  placeholder="admin@hospital.com"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm"
                />
                <Button
                  size="sm"
                  loading={busy === "admin"}
                  disabled={!adminEmail.trim()}
                  onClick={() =>
                    void run("admin", async () => {
                      const result = await api.issueHospitalAdmin(hospital.id, {
                        email: adminEmail.trim(),
                      });
                      onIssued({
                        hospital: h,
                        email: result.email,
                        password: result.temporaryPassword,
                      });
                      setAdminEmail("");
                    })
                  }
                >
                  Issue
                </Button>
              </div>
            </ConfigBlock>

            {/* Status — the one destructive action, behind a real confirmation. */}
            <ConfigBlock
              title="Access"
              hint="Suspension takes the hospital offline immediately — for non-payment or a security incident, not a pause button."
            >
              {h.status === "suspended" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === "status"}
                  onClick={() =>
                    void run("status", () => api.setHospitalStatus(hospital.id, "active"))
                  }
                >
                  Reactivate hospital
                </Button>
              ) : (
                <Button variant="danger" size="sm" onClick={() => setConfirmSuspend(true)}>
                  Suspend hospital
                </Button>
              )}
            </ConfigBlock>
          </div>
        )}
      </div>

      {confirmSuspend && (
        <ConfirmDialog
          title={`Suspend ${h.hospitalName}?`}
          body={
            <>
              Every member of their staff will be unable to log in, <strong>immediately</strong>.
              This is for non-payment or a security incident — it is not a pause button.
            </>
          }
          confirmLabel="Suspend hospital"
          busy={busy === "status"}
          onCancel={() => setConfirmSuspend(false)}
          onConfirm={() =>
            void run("status", async () => {
              await api.setHospitalStatus(hospital.id, "suspended");
              setConfirmSuspend(false);
            })
          }
        />
      )}
    </Drawer>
  );
}

/* ── create modal ─────────────────────────────────────────────────────────────── */

function NewHospitalModal({
  editions,
  onClose,
  onCreated,
}: {
  editions: Edition[];
  onClose: () => void;
  onCreated: (c: Created) => void;
}) {
  const { api } = useOperator();
  const [form, setForm] = useState({
    slug: "",
    hospitalName: "",
    planCode: "PLAN_CLINIC",
    adminEmail: "",
    maxBranches: "1",
    licenseExpiresAt: "",
    graceDays: "",
    customDomain: "",
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFieldErrors({});
    setError(null);
    try {
      // A date input (YYYY-MM-DD) → ISO end-of-day, so a licence "until the 30th" is valid through it.
      const expiresIso = form.licenseExpiresAt
        ? new Date(`${form.licenseExpiresAt}T23:59:59`).toISOString()
        : undefined;
      const branches = Number(form.maxBranches);
      const grace = form.graceDays.trim() === "" ? undefined : Number(form.graceDays);
      const dom = form.customDomain.trim().toLowerCase();
      const result = await api.createHospital({
        slug: form.slug,
        hospitalName: form.hospitalName,
        planCode: form.planCode,
        adminEmail: form.adminEmail,
        ...(Number.isFinite(branches) && branches > 1 ? { maxBranches: branches } : {}),
        ...(dom ? { customDomain: dom } : {}),
        ...(expiresIso ? { licenseExpiresAt: expiresIso } : {}),
        ...(grace != null && Number.isFinite(grace) ? { graceDays: grace } : {}),
      });
      onCreated({
        hospital: result.hospital,
        email: result.admin.email,
        ...(result.admin.temporaryPassword ? { password: result.admin.temporaryPassword } : {}),
      });
    } catch (err) {
      if (err instanceof ApiClientError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setError(err instanceof ApiClientError ? err.message : "Could not create the hospital.");
    } finally {
      setSaving(false);
    }
  }

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Modal title="New hospital" onClose={onClose}>
      <form onSubmit={submit} className="space-y-5">
        <p className="text-sm text-[var(--color-fg-muted)]">
          Creates the database, runs its migrations, seeds the roles and issues the first
          administrator — one operation. A hospital without an administrator is a room locked from
          the inside.
        </p>
        {error && (
          <div className="rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Hospital name"
            value={form.hospitalName}
            onChange={(e) => set({ hospitalName: e.target.value })}
            required
          />
          <Field
            label="Address (slug) — permanent"
            value={form.slug}
            onChange={(e) => set({ slug: e.target.value.toLowerCase() })}
            required
            placeholder="sunrise"
            className="font-mono"
            {...(fieldErrors.slug?.[0] ? { error: fieldErrors.slug[0] } : {})}
            hint="Becomes their hostname AND their database name. It cannot be changed later."
          />
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">Edition</span>
            <select
              value={form.planCode}
              onChange={(e) => set({ planCode: e.target.value })}
              className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm"
            >
              {editions.map((ed) => (
                <option key={ed.code} value={ed.code}>
                  {ed.name}
                  {ed.limits.maxUsers ? ` — ${String(ed.limits.maxUsers)} seats` : ""}
                </option>
              ))}
            </select>
          </label>
          <Field
            label="First administrator (email)"
            type="email"
            value={form.adminEmail}
            onChange={(e) => set({ adminEmail: e.target.value })}
            required
          />
          <Field
            label="Supported branches"
            type="number"
            min={1}
            value={form.maxBranches}
            onChange={(e) => set({ maxBranches: e.target.value })}
            hint="How many branches this hospital may create. 1 = single-site. Raise it any time."
          />
          <Field
            label="Licence valid until"
            type="date"
            value={form.licenseExpiresAt}
            onChange={(e) => set({ licenseExpiresAt: e.target.value })}
            hint="Blank = default trial. After this (plus grace) the hospital is blocked until extended."
          />
          <Field
            label="Grace days"
            type="number"
            min={0}
            value={form.graceDays}
            onChange={(e) => set({ graceDays: e.target.value })}
            placeholder="default"
            hint="Days after expiry the hospital still runs (with a renewal banner) before access is cut."
          />
          <Field
            label="Custom domain (optional)"
            value={form.customDomain}
            onChange={(e) => set({ customDomain: e.target.value.toLowerCase() })}
            placeholder="care.hospital.com"
            className="font-mono"
            hint="A hostname that resolves to this hospital, in addition to its subdomain."
          />
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={saving}>
            Create hospital
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── the fleet ────────────────────────────────────────────────────────────── */

function Console() {
  const { operator, isSuperAdmin, logout } = useOperator();
  const { api } = useOperator();

  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [editions, setEditions] = useState<Edition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<Hospital | null>(null);
  const [created, setCreated] = useState<Created | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, plans] = await Promise.all([api.listHospitals(), api.listEditions()]);
      setHospitals(list);
      setEditions(plans);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load the fleet.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <main className="min-h-screen bg-[var(--color-bg-subtle)]">
      <header
        className="sticky top-0 z-30 border-b border-[var(--color-border)]"
        style={{ background: "var(--surface-glass)", backdropFilter: "blur(12px)" }}
      >
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-[var(--color-on-accent)] shadow-[var(--shadow-xs)]"
              style={{ background: "var(--gradient-brand)" }}
            >
              P
            </div>
            <div>
              <h1 className="text-sm font-semibold text-[var(--color-fg)]">Operator console</h1>
              <p className="text-xs text-[var(--color-fg-muted)]">
                {hospitals.length} hospitals · {operator?.email}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Button variant="secondary" size="sm" onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-6 p-6">
        {error && (
          <div className="rounded-xl border border-[var(--color-danger)]/30 bg-[var(--color-danger-bg)] px-4 py-3 text-sm text-[var(--color-danger)]">
            {error}
          </div>
        )}

        {/* Credentials, shown ONCE (we store only a hash). */}
        {created && (
          <div className="mc-fade-in rounded-2xl border border-[var(--color-success)]/30 bg-[var(--color-success-bg)] p-5">
            <h2 className="font-semibold text-[var(--color-success)]">
              {created.hospital.hospitalName} is ready
            </h2>
            <p className="mt-1 text-sm text-[var(--color-success)]">
              Hand these to the hospital. The password is shown once and cannot be recovered.
            </p>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-[var(--color-success)]/80">Sign-in URL</dt>
                <dd className="font-mono break-all text-[var(--color-success)]">
                  {created.hospital.url}
                </dd>
              </div>
              <div>
                <dt className="text-[var(--color-success)]/80">Email</dt>
                <dd className="font-mono break-all text-[var(--color-success)]">{created.email}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-success)]/80">Temporary password</dt>
                <dd className="font-mono font-semibold text-[var(--color-success)]">
                  {created.password ?? "(the one you set)"}
                </dd>
              </div>
            </dl>
            <Button variant="secondary" size="sm" className="mt-4" onClick={() => setCreated(null)}>
              I have copied these
            </Button>
          </div>
        )}

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold tracking-tight text-[var(--color-fg)]">
              Hospitals
            </h2>
            <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">
              Select a hospital to view and configure it.
            </p>
          </div>
          {isSuperAdmin && <Button onClick={() => setShowCreate(true)}>+ New hospital</Button>}
        </div>

        <div className="overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-xs)]">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
              <tr>
                <th className="px-6 py-3.5 font-medium">Hospital</th>
                <th className="px-6 py-3.5 font-medium">Status</th>
                <th className="px-6 py-3.5 font-medium">Edition</th>
                <th className="px-6 py-3.5 font-medium">Licence</th>
                <th className="px-6 py-3.5 font-medium">Expiry</th>
                <th className="px-6 py-3.5 text-right font-medium">Branches</th>
                <th className="px-6 py-3.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-[var(--color-fg-subtle)]">
                    Loading the fleet…
                  </td>
                </tr>
              ) : hospitals.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-12 text-center text-[var(--color-fg-subtle)]">
                    No hospitals yet.
                  </td>
                </tr>
              ) : (
                hospitals.map((hospital) => {
                  const lic = licenseBadge(hospital.license);
                  return (
                    <tr
                      key={hospital.id}
                      onClick={() => setSelected(hospital)}
                      className="cursor-pointer transition-colors hover:bg-[var(--color-bg-subtle)]"
                    >
                      <td className="px-6 py-4">
                        <span className="block font-medium text-[var(--color-fg)]">
                          {hospital.hospitalName}
                        </span>
                        <span className="font-mono text-xs text-[var(--color-fg-muted)]">
                          {hospital.url.replace(/^https?:\/\//, "")}
                        </span>
                        {hospital.customDomain && (
                          <span className="mt-0.5 block font-mono text-xs text-[var(--color-fg-subtle)]">
                            ↳ {hospital.customDomain}
                          </span>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <Badge tone={statusTone(hospital.status)} dot>
                          {hospital.status}
                        </Badge>
                      </td>
                      <td className="px-6 py-4 text-[var(--color-fg-muted)]">
                        {hospital.planCode ?? "—"}
                      </td>
                      <td className="px-6 py-4">
                        <Badge tone={lic.tone}>{lic.label}</Badge>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {hospital.license.state === "PERPETUAL" ? (
                          <span className="text-[var(--color-fg-muted)]">No expiry</span>
                        ) : (
                          <>
                            <span className="block text-[var(--color-fg)]">
                              {shortDate(hospital.license.expiresAt)}
                            </span>
                            {hospital.license.daysRemaining != null && (
                              <span className="text-xs text-[var(--color-fg-subtle)]">
                                {hospital.license.daysRemaining >= 0
                                  ? `${hospital.license.daysRemaining}d remaining`
                                  : `${Math.abs(hospital.license.daysRemaining)}d overdue`}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right tabular-nums text-[var(--color-fg-muted)]">
                        {hospital.maxBranches ?? 1}
                      </td>
                      <td className="px-6 py-4 text-right whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 text-sm font-medium text-[var(--color-brand-600)]">
                          Details
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            aria-hidden
                          >
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-[var(--color-fg-subtle)]">
          Operators manage hospitals, not their patients. Nothing in this console exposes clinical
          data, and every action taken here is recorded in the hospital&apos;s own audit trail —
          where their compliance officer can see it.
        </p>
      </div>

      {showCreate && (
        <NewHospitalModal
          editions={editions}
          onClose={() => setShowCreate(false)}
          onCreated={(c) => {
            setCreated(c);
            setShowCreate(false);
            void load();
          }}
        />
      )}

      {selected && (
        <TenantDrawer
          hospital={selected}
          editions={editions}
          isSuperAdmin={isSuperAdmin}
          onClose={() => setSelected(null)}
          onChanged={() => void load()}
          onIssued={(c) => setCreated(c)}
        />
      )}
    </main>
  );
}

function Gate() {
  const { operator } = useOperator();
  return operator ? <Console /> : <OperatorLogin />;
}

export default function AdminPage() {
  return (
    <OperatorProvider>
      <Gate />
    </OperatorProvider>
  );
}
