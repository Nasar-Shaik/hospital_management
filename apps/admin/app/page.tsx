"use client";

/**
 * The operator console (Doc 02 A1).
 *
 * One page, because there is one job: see every hospital, create a new one with
 * its administrator, change what a hospital pays, and take one offline when you
 * must. A console that buries these behind navigation is a console nobody can use
 * at 2am when a customer is locked out.
 *
 * What is NOT here, and must never be: any view of patient data. An operator
 * manages the container. The contents belong to the hospital.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ApiClientError, type Edition, type Hospital } from "@medicore/api-client";
import { ThemeToggle } from "@medicore/ui";
import { OperatorProvider, useOperator } from "../lib/operator";

function statusColor(status: Hospital["status"]): string {
  if (status === "active") return "bg-[var(--color-success-bg)] text-[var(--color-success)]";
  if (status === "trial") return "bg-[var(--color-warning-bg)] text-[var(--color-warning)]";
  if (status === "suspended") return "bg-[var(--color-danger-bg)] text-[var(--color-danger)]";
  return "bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)]";
}

/** Colour + human label for a hospital's licence state (ADR-0016). */
function licenseBadge(license: Hospital["license"]): { className: string; label: string } {
  const days = license.daysRemaining;
  const on = (n: number | null) => (n == null ? "" : ` · ${String(n)}d`);
  switch (license.state) {
    case "PERPETUAL":
      return {
        className: "bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)]",
        label: "Perpetual",
      };
    case "EXPIRED":
      return {
        className: "bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
        label: "Expired",
      };
    case "GRACE":
      return {
        className: "bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
        label: `Grace${on(days)}`,
      };
    default:
      // ACTIVE — amber when close to expiry, green otherwise.
      return days != null && days <= 10
        ? {
            className: "bg-[var(--color-warning-bg)] text-[var(--color-warning)]",
            label: `Expiring${on(days)}`,
          }
        : {
            className: "bg-[var(--color-success-bg)] text-[var(--color-success)]",
            label: `Active${on(days)}`,
          };
  }
}

/** ISO expiry → a short, unambiguous date for the console. */
function shortDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
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
      // One message for every failure. The operator list is short and extremely
      // valuable, so this form must not become a way to discover who works here.
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
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-[var(--color-bg-elevated)] border border-[var(--color-border)] text-lg font-bold text-[var(--color-fg)]">
            P
          </div>
          <h1 className="text-xl font-semibold text-[var(--color-fg)]">Operator console</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-subtle)]">
            PaperlessTech platform — staff only.
          </p>
        </div>

        <div className="space-y-4 rounded-xl bg-[var(--color-bg-elevated)] p-6 shadow-xl">
          {error && (
            <p className="rounded-lg bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]">
              {error}
            </p>
          )}

          <label className="block">
            <span className="text-sm font-medium text-[var(--color-fg)]">Email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-sm font-medium text-[var(--color-fg)]">Password</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm"
            />
          </label>

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-[var(--color-fg)] py-2.5 text-sm font-medium text-[var(--color-bg)] disabled:opacity-60"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
      </form>
    </main>
  );
}

/* ── the fleet ────────────────────────────────────────────────────────────── */

function Console() {
  const { api, operator, isSuperAdmin, logout } = useOperator();

  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [editions, setEditions] = useState<Edition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
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
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{
    hospital: Hospital;
    email: string;
    password?: string;
  } | null>(null);

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

  async function createHospital(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFieldErrors({});
    setError(null);
    try {
      // `licenseExpiresAt` is a date input (YYYY-MM-DD); the API wants an ISO datetime —
      // end-of-day, so a licence bought "until the 30th" is valid through all of the 30th.
      const expiresIso = form.licenseExpiresAt
        ? new Date(`${form.licenseExpiresAt}T23:59:59`).toISOString()
        : undefined;
      const branches = Number(form.maxBranches);
      const grace = form.graceDays.trim() === "" ? undefined : Number(form.graceDays);
      const domain = form.customDomain.trim().toLowerCase();
      const result = await api.createHospital({
        slug: form.slug,
        hospitalName: form.hospitalName,
        planCode: form.planCode,
        adminEmail: form.adminEmail,
        ...(Number.isFinite(branches) && branches > 1 ? { maxBranches: branches } : {}),
        ...(domain ? { customDomain: domain } : {}),
        ...(expiresIso ? { licenseExpiresAt: expiresIso } : {}),
        ...(grace != null && Number.isFinite(grace) ? { graceDays: grace } : {}),
      });
      setCreated({
        hospital: result.hospital,
        email: result.admin.email,
        ...(result.admin.temporaryPassword ? { password: result.admin.temporaryPassword } : {}),
      });
      setShowForm(false);
      setForm({
        slug: "",
        hospitalName: "",
        planCode: "PLAN_CLINIC",
        adminEmail: "",
        maxBranches: "1",
        licenseExpiresAt: "",
        graceDays: "",
        customDomain: "",
      });
      await load();
    } catch (err) {
      if (err instanceof ApiClientError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setError(err instanceof ApiClientError ? err.message : "Could not create the hospital.");
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(hospital: Hospital, status: Hospital["status"]) {
    setError(null);
    try {
      await api.setHospitalStatus(hospital.id, status);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not change the status.");
    }
  }

  async function changePlan(hospital: Hospital, planCode: string) {
    setError(null);
    try {
      await api.setHospitalPlan(hospital.id, planCode);
      await load();
    } catch (err) {
      // A refused downgrade ("this hospital has 12 staff; Clinic allows 10") is
      // expected operator feedback, not a failure — show the API's own words.
      setError(err instanceof ApiClientError ? err.message : "Could not change the plan.");
    }
  }

  async function issueAdmin(hospital: Hospital) {
    const email = window.prompt(`Issue an administrator for ${hospital.hospitalName}.\n\nEmail:`);
    if (!email) return;
    setError(null);
    try {
      const result = await api.issueHospitalAdmin(hospital.id, { email });
      setCreated({ hospital, email: result.email, password: result.temporaryPassword });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not issue the administrator.");
    }
  }

  async function changeBranches(hospital: Hospital) {
    const current = hospital.maxBranches ?? 1;
    const answer = window.prompt(
      `Supported branches for ${hospital.hospitalName}.\n\nLowering this does NOT delete branches — it just stops new ones being created until raised again.`,
      String(current),
    );
    if (answer == null) return;
    const n = Number(answer.trim());
    if (!Number.isFinite(n) || n < 1) {
      setError("Supported branches must be a whole number of at least 1.");
      return;
    }
    setError(null);
    try {
      await api.setHospitalLimits(hospital.id, n);
      await load();
    } catch (err) {
      setError(
        err instanceof ApiClientError ? err.message : "Could not update supported branches.",
      );
    }
  }

  async function extendLicense(hospital: Hospital) {
    const answer = window.prompt(
      `Extend ${hospital.hospitalName}'s licence by how many days?\n\nCounts from the later of today or the current expiry, so it never shortens an active licence.`,
      "365",
    );
    if (answer == null) return;
    const days = Number(answer.trim());
    if (!Number.isFinite(days) || days < 1) {
      setError("Enter a whole number of days (1 or more).");
      return;
    }
    setError(null);
    try {
      await api.setHospitalLicense(hospital.id, { extendDays: days });
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not extend the licence.");
    }
  }

  async function changeDomain(hospital: Hospital) {
    const answer = window.prompt(
      `Custom domain for ${hospital.hospitalName}.\n\nA bare hostname (e.g. care.hospital.com) that resolves to this hospital. Clear the box to detach. DNS/TLS is set up separately.`,
      hospital.customDomain ?? "",
    );
    if (answer == null) return;
    const domain = answer.trim().toLowerCase();
    setError(null);
    try {
      await api.setHospitalDomain(hospital.id, domain === "" ? null : domain);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not update the custom domain.");
    }
  }

  return (
    <main className="min-h-screen bg-[var(--color-bg-subtle)]">
      <header className="border-b border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-fg)]">Operator console</h1>
            <p className="text-xs text-[var(--color-fg-muted)]">
              {hospitals.length} hospitals · signed in as {operator?.email} (
              {operator?.roles.join(", ")})
            </p>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <button
              onClick={logout}
              className="rounded-lg border border-[var(--color-border-strong)] px-3 py-1.5 text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-6 p-6">
        {error && (
          <div className="rounded-lg border border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        )}

        {/* Shown ONCE. We store only a hash, so there is no "show it again" — and
            pretending otherwise would be a lie we could not honour. */}
        {created && (
          <div className="rounded-xl border border-[var(--color-success)] bg-[var(--color-success-bg)] p-5">
            <h2 className="font-semibold text-[var(--color-success)]">
              {created.hospital.hospitalName} is ready
            </h2>
            <p className="mt-1 text-sm text-[var(--color-success)]">
              Hand these to the hospital. The password is shown once and cannot be recovered — we
              store only a hash of it.
            </p>
            <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-[var(--color-success)]">Sign-in URL</dt>
                <dd className="font-mono text-[var(--color-success)]">{created.hospital.url}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-success)]">Email</dt>
                <dd className="font-mono text-[var(--color-success)]">{created.email}</dd>
              </div>
              <div>
                <dt className="text-[var(--color-success)]">Temporary password</dt>
                <dd className="font-mono font-semibold text-[var(--color-success)]">
                  {created.password ?? "(the one you set)"}
                </dd>
              </div>
            </dl>
            <button
              onClick={() => setCreated(null)}
              className="mt-4 text-sm font-medium text-[var(--color-success)] underline"
            >
              I have copied these
            </button>
          </div>
        )}

        {isSuperAdmin && !showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="rounded-lg bg-[var(--color-fg)] px-4 py-2 text-sm font-medium text-[var(--color-bg)]"
          >
            + New hospital
          </button>
        )}

        {showForm && (
          <form
            onSubmit={createHospital}
            className="space-y-4 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-6"
          >
            <h2 className="font-semibold text-[var(--color-fg)]">New hospital</h2>
            <p className="text-sm text-[var(--color-fg-muted)]">
              Creates the database, runs its migrations, seeds the roles and issues the first
              administrator — one operation. A hospital without an administrator is a room locked
              from the inside.
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="text-sm font-medium text-[var(--color-fg)]">Hospital name</span>
                <input
                  value={form.hospitalName}
                  onChange={(e) => setForm({ ...form, hospitalName: e.target.value })}
                  required
                  className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-[var(--color-fg)]">
                  Address (slug) — permanent
                </span>
                <input
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })}
                  required
                  placeholder="sunrise"
                  className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] px-3 py-2 font-mono text-sm"
                />
                {fieldErrors.slug && (
                  <span className="mt-1 block text-xs text-[var(--color-danger)]">
                    {fieldErrors.slug[0]}
                  </span>
                )}
                <span className="mt-1 block text-xs text-[var(--color-fg-muted)]">
                  Becomes their hostname AND their database name. It cannot be changed later.
                </span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-[var(--color-fg)]">Edition</span>
                <select
                  value={form.planCode}
                  onChange={(e) => setForm({ ...form, planCode: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm"
                >
                  {editions.map((edition) => (
                    <option key={edition.code} value={edition.code}>
                      {edition.name}
                      {edition.limits.maxUsers ? ` — ${String(edition.limits.maxUsers)} seats` : ""}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-[var(--color-fg)]">
                  First administrator (email)
                </span>
                <input
                  type="email"
                  value={form.adminEmail}
                  onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
                  required
                  className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm"
                />
              </label>

              <label className="block">
                <span className="text-sm font-medium text-[var(--color-fg)]">
                  Supported branches
                </span>
                <input
                  type="number"
                  min={1}
                  value={form.maxBranches}
                  onChange={(e) => setForm({ ...form, maxBranches: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm"
                />
                <span className="mt-1 block text-xs text-[var(--color-fg-muted)]">
                  How many branches this hospital may create. 1 = single-site. Raise it any time.
                </span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-[var(--color-fg)]">
                  Licence valid until
                </span>
                <input
                  type="date"
                  value={form.licenseExpiresAt}
                  onChange={(e) => setForm({ ...form, licenseExpiresAt: e.target.value })}
                  className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm"
                />
                <span className="mt-1 block text-xs text-[var(--color-fg-muted)]">
                  Leave blank for a default trial. After this date (plus grace) the hospital is
                  blocked until you extend.
                </span>
              </label>

              <label className="block">
                <span className="text-sm font-medium text-[var(--color-fg)]">Grace days</span>
                <input
                  type="number"
                  min={0}
                  value={form.graceDays}
                  onChange={(e) => setForm({ ...form, graceDays: e.target.value })}
                  placeholder="default"
                  className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm"
                />
                <span className="mt-1 block text-xs text-[var(--color-fg-muted)]">
                  Days after expiry the hospital still runs (with a renewal banner) before access is
                  cut.
                </span>
              </label>

              <label className="block sm:col-span-2">
                <span className="text-sm font-medium text-[var(--color-fg)]">
                  Custom domain <span className="text-[var(--color-fg-muted)]">(optional)</span>
                </span>
                <input
                  value={form.customDomain}
                  onChange={(e) => setForm({ ...form, customDomain: e.target.value.toLowerCase() })}
                  placeholder="care.hospital.com"
                  className="mt-1 w-full rounded-lg border border-[var(--color-border-strong)] px-3 py-2 font-mono text-sm"
                />
                <span className="mt-1 block text-xs text-[var(--color-fg-muted)]">
                  A hostname that resolves to this hospital, in addition to its subdomain. DNS/TLS
                  is set up separately.
                </span>
              </label>
            </div>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={saving}
                className="rounded-lg bg-[var(--color-fg)] px-4 py-2 text-sm font-medium text-[var(--color-bg)] disabled:opacity-60"
              >
                {saving ? "Creating…" : "Create hospital"}
              </button>
              <button
                type="button"
                onClick={() => setShowForm(false)}
                className="rounded-lg border border-[var(--color-border-strong)] px-4 py-2 text-sm text-[var(--color-fg-muted)]"
              >
                Cancel
              </button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)]">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-[var(--color-border)] text-xs text-[var(--color-fg-muted)] uppercase">
              <tr>
                <th className="px-4 py-3 font-medium">Hospital</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Edition</th>
                <th className="px-4 py-3 font-medium">Licence</th>
                <th className="px-4 py-3 font-medium">Branches</th>
                {isSuperAdmin && <th className="px-4 py-3 font-medium">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {loading && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-[var(--color-fg-subtle)]">
                    Loading the fleet…
                  </td>
                </tr>
              )}

              {!loading &&
                hospitals.map((hospital) => {
                  const lic = licenseBadge(hospital.license);
                  return (
                    <tr key={hospital.id}>
                      <td className="px-4 py-3">
                        <span className="block font-medium text-[var(--color-fg)]">
                          {hospital.hospitalName}
                        </span>
                        <a
                          href={hospital.url}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-xs text-[var(--color-fg-muted)] underline"
                        >
                          {hospital.url}
                        </a>
                        {hospital.customDomain && (
                          <span className="mt-0.5 block font-mono text-xs text-[var(--color-fg-subtle)]">
                            ↳ {hospital.customDomain}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-medium ${statusColor(hospital.status)}`}
                        >
                          {hospital.status}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {isSuperAdmin ? (
                          <select
                            value={hospital.planCode ?? ""}
                            onChange={(e) => void changePlan(hospital, e.target.value)}
                            className="rounded-md border border-[var(--color-border-strong)] px-2 py-1 text-xs"
                          >
                            <option value="">— none —</option>
                            {editions.map((edition) => (
                              <option key={edition.code} value={edition.code}>
                                {edition.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="text-[var(--color-fg-muted)]">
                            {hospital.planCode ?? "—"}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-xs font-medium ${lic.className}`}
                          title={
                            hospital.license.expiresAt
                              ? `Valid until ${shortDate(hospital.license.expiresAt)}`
                              : "No expiry set"
                          }
                        >
                          {lic.label}
                        </span>
                        <span className="mt-0.5 block text-xs text-[var(--color-fg-subtle)]">
                          {hospital.license.state === "PERPETUAL"
                            ? "no expiry"
                            : shortDate(hospital.license.expiresAt)}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[var(--color-fg-muted)]">
                        {hospital.maxBranches ?? 1}
                      </td>
                      {isSuperAdmin && (
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              onClick={() => void extendLicense(hospital)}
                              className="rounded-md border border-[var(--color-border-strong)] px-2 py-1 text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)]"
                            >
                              Extend licence
                            </button>
                            <button
                              onClick={() => void changeBranches(hospital)}
                              className="rounded-md border border-[var(--color-border-strong)] px-2 py-1 text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)]"
                            >
                              Branches
                            </button>
                            <button
                              onClick={() => void changeDomain(hospital)}
                              className="rounded-md border border-[var(--color-border-strong)] px-2 py-1 text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)]"
                            >
                              Domain
                            </button>
                            <button
                              onClick={() => void issueAdmin(hospital)}
                              className="rounded-md border border-[var(--color-border-strong)] px-2 py-1 text-xs text-[var(--color-fg)] hover:bg-[var(--color-bg-subtle)]"
                            >
                              Issue admin
                            </button>
                            {hospital.status === "suspended" ? (
                              <button
                                onClick={() => void changeStatus(hospital, "active")}
                                className="rounded-md border border-[var(--color-success)] px-2 py-1 text-xs text-[var(--color-success)] hover:bg-[var(--color-success-bg)]"
                              >
                                Reactivate
                              </button>
                            ) : (
                              <button
                                onClick={() => {
                                  // Suspension takes the hospital OFFLINE — every member
                                  // of their staff loses access immediately. Never a
                                  // one-click action.
                                  if (
                                    window.confirm(
                                      `Suspend ${hospital.hospitalName}?\n\nEvery member of their staff will be unable to log in, immediately. This is for non-payment or a security incident — it is not a pause button.`,
                                    )
                                  ) {
                                    void changeStatus(hospital, "suspended");
                                  }
                                }}
                                className="rounded-md border border-[var(--color-danger)] px-2 py-1 text-xs text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)]"
                              >
                                Suspend
                              </button>
                            )}
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>

        <p className="text-xs text-[var(--color-fg-subtle)]">
          Operators manage hospitals, not their patients. Nothing in this console exposes clinical
          data, and every action taken here is recorded in the hospital&apos;s own audit trail —
          where their compliance officer can see it.
        </p>
      </div>
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
