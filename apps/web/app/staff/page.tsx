"use client";

/**
 * Staff directory (Doc 02 A3) — where an administrator runs the hospital's logins.
 *
 * The screen where RBAC becomes real: add a colleague, give them a role, and the permissions
 * apply on their very next request. It also carries the account's whole life — edit the
 * profile, disable a login the moment someone leaves (which ends their sessions instantly),
 * re-enable it, and reset a forgotten password.
 *
 * The registration form ADAPTS to the role: a doctor is asked for specialty and medical-council
 * registration; a cashier is not. Every professional field is optional, because a form that
 * refuses to save an urgently-hired doctor until every box is ticked is a form that gets
 * bypassed on paper.
 *
 * A temporary password is shown ONCE, in a panel that says so. We store only its hash, so
 * there is no "show it again" — pretending otherwise would be a lie we could not honour.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  ApiClientError,
  STAFF_GENDERS,
  type Branch,
  type Role,
  type StaffMember,
  type StaffProfile,
} from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { useBranch } from "../../components/BranchProvider";
import {
  Alert,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  DataTable,
  Field,
  PermissionGate,
  type Column,
} from "../../components/ui";
import { rupees, toPaise } from "../../lib/money";

function statusTone(status: StaffMember["status"]): "success" | "danger" | "neutral" {
  if (status === "active") return "success";
  if (status === "disabled" || status === "locked") return "danger";
  return "neutral";
}

/** Roles that see patients or run diagnostics — the ones a qualification and registration apply to. */
const CLINICAL_ROLES = new Set([
  "DOCTOR",
  "NURSE",
  "LAB_TECHNICIAN",
  "PATHOLOGIST",
  "RADIOLOGIST",
  "PHARMACIST",
]);
/** Roles that carry a clinical specialty (drives the per-doctor consultation fee later). */
const SPECIALTY_ROLES = new Set(["DOCTOR", "PATHOLOGIST", "RADIOLOGIST"]);

interface FormState {
  name: string;
  email: string;
  role: string;
  phone: string;
  employeeId: string;
  designation: string;
  department: string;
  specialty: string;
  /** Rupees, as typed — converted to paise on submit. */
  consultationFee: string;
  qualification: string;
  registrationNo: string;
  gender: string;
  dateOfBirth: string;
  joiningDate: string;
  address: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  /** Doctors only: feature this person on the public website. */
  showOnPublicSite: boolean;
  /**
   * A scanned signature, for the documents this person signs. NOT doctors-only: a doctor signs the
   * OPD slip, and whoever takes the money signs the receipt — a cashier's signature on a payment
   * is as much a signature as a clinician's on a prescription, and the desk is where the same
   * document is signed by several different people across a shift.
   */
  signature: string;
  /** Branch access (ADR-0015): true = every branch; false = only `branchIds`. */
  allBranches: boolean;
  /** The specific branches this person works in — meaningful only when `allBranches` is false. */
  branchIds: string[];
}

const EMPTY_FORM: FormState = {
  name: "",
  email: "",
  role: "",
  phone: "",
  employeeId: "",
  designation: "",
  department: "",
  specialty: "",
  consultationFee: "",
  qualification: "",
  registrationNo: "",
  gender: "",
  dateOfBirth: "",
  joiningDate: "",
  address: "",
  emergencyContactName: "",
  emergencyContactPhone: "",
  showOnPublicSite: false,
  signature: "",
  allBranches: true,
  branchIds: [],
};

function formFromMember(m: StaffMember): FormState {
  const p = m.profile ?? {};
  return {
    name: m.name,
    email: m.email,
    role: m.roles[0] ?? "",
    phone: m.phone ?? "",
    employeeId: m.employeeId ?? "",
    designation: p.designation ?? "",
    department: p.department ?? "",
    specialty: p.specialty ?? "",
    consultationFee: p.consultationFee !== undefined ? String(p.consultationFee / 100) : "",
    qualification: p.qualification ?? "",
    registrationNo: p.registrationNo ?? "",
    gender: p.gender ?? "",
    dateOfBirth: p.dateOfBirth ?? "",
    joiningDate: p.joiningDate ?? "",
    address: p.address ?? "",
    emergencyContactName: p.emergencyContactName ?? "",
    emergencyContactPhone: p.emergencyContactPhone ?? "",
    showOnPublicSite: p.showOnPublicSite ?? false,
    signature: p.signature ?? "",
    // An empty branch list is a hospital-wide binding ("all branches"); a non-empty one confines.
    allBranches: (m.branchIds ?? []).length === 0,
    branchIds: m.branchIds ?? [],
  };
}

/** Only send fields that were filled — an empty string is "not provided", not a value. */
function profileFromForm(f: FormState): StaffProfile {
  const out: StaffProfile = {};
  const put = (k: keyof StaffProfile, v: string) => {
    if (v.trim()) (out[k] as string) = v.trim();
  };
  put("designation", f.designation);
  put("department", f.department);
  put("specialty", f.specialty);
  // Rupees in the box → paise on the wire. Blank means "not set" — the hospital tariff applies.
  if (f.consultationFee.trim()) out.consultationFee = toPaise(f.consultationFee);
  put("qualification", f.qualification);
  put("registrationNo", f.registrationNo);
  if (f.gender) out.gender = f.gender as StaffProfile["gender"];
  put("dateOfBirth", f.dateOfBirth);
  put("joiningDate", f.joiningDate);
  put("address", f.address);
  put("emergencyContactName", f.emergencyContactName);
  put("emergencyContactPhone", f.emergencyContactPhone);
  // Always sent (not via `put`), because the profile is MERGED server-side: to UN-publish a
  // doctor the `false` has to overwrite the stored `true`, so omitting it would never clear.
  out.showOnPublicSite = f.showOnPublicSite;
  // Only a valid image data URI goes on the wire (the server enforces this too). Omitted when
  // blank — the merge keeps any existing signature rather than the empty box wiping it.
  if (f.signature.startsWith("data:image")) out.signature = f.signature;
  return out;
}

/** A simple centred dialog — the app has no modal primitive, and this is the one screen that needs one. */
function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-3">
          <h2 className="text-sm font-semibold text-[var(--color-fg)]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
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

function labelledSelect(
  label: string,
  value: string,
  onChange: (v: string) => void,
  options: { value: string; label: string }[],
  placeholder = "Choose…",
) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)]"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The create/edit form. Adapts its professional fields to the chosen role. */
function StaffForm({
  mode,
  initial,
  roles,
  branches,
  onSubmit,
  saving,
  fieldErrors,
}: {
  mode: "create" | "edit";
  initial: FormState;
  roles: Role[];
  branches: Branch[];
  onSubmit: (f: FormState) => void;
  saving: boolean;
  fieldErrors: Record<string, string[]>;
}) {
  const [form, setForm] = useState<FormState>(initial);
  /**
   * Why the signature's size complaint is a line under the field and not `window.alert`: an alert
   * is dismissed and then gone, so the person is left staring at a form with no signature on it and
   * nothing saying why. This stays until they pick a different file.
   */
  const [signatureError, setSignatureError] = useState<string | null>(null);
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));
  const isClinical = CLINICAL_ROLES.has(form.role);
  const hasSpecialty = SPECIALTY_ROLES.has(form.role);

  const toggleBranch = (id: string) =>
    set({
      branchIds: form.branchIds.includes(id)
        ? form.branchIds.filter((b) => b !== id)
        : [...form.branchIds, id],
    });

  return (
    <form
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        onSubmit(form);
      }}
      className="space-y-5"
    >
      <div>
        <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
          Account
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Full name"
            name="name"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            error={fieldErrors.name?.[0]}
            required
          />
          <Field
            label="Email"
            name="email"
            type="email"
            value={form.email}
            onChange={(e) => set({ email: e.target.value })}
            error={fieldErrors.email?.[0]}
            required
            disabled={mode === "edit"}
            hint={mode === "edit" ? "Email is the login and cannot be changed here." : undefined}
          />
          {labelledSelect(
            "Role",
            form.role,
            (v) => set({ role: v }),
            roles.map((r) => ({ value: r.code, label: r.name })),
            "No role (can sign in, can do nothing)",
          )}
          <Field
            label="Employee ID"
            name="employeeId"
            value={form.employeeId}
            onChange={(e) => set({ employeeId: e.target.value })}
          />
        </div>
        {mode === "edit" && (
          <p className="mt-2 text-xs text-[var(--color-fg-muted)]">
            Changing the role here is not yet supported — use the role tools. This form edits the
            profile.
          </p>
        )}
      </div>

      {/*
        Branch access (ADR-0015). Shown only when the hospital actually has more than one site —
        a single-branch hospital never needs to think about this, and the binding stays "all".
        "All branches" is the hospital-wide binding (admins, directors); "Specific branches"
        confines a receptionist or nurse to where they work.
      */}
      {branches.length > 1 && (
        <div>
          <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
            Branch access
          </p>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
              <input
                type="radio"
                name="branch-access"
                checked={form.allBranches}
                onChange={() => set({ allBranches: true })}
              />
              All branches
              <span className="text-xs text-[var(--color-fg-muted)]">
                — works across every site, and may switch between them
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--color-fg)]">
              <input
                type="radio"
                name="branch-access"
                checked={!form.allBranches}
                onChange={() => set({ allBranches: false })}
              />
              Specific branches
            </label>

            {!form.allBranches && (
              <div className="ml-6 mt-1 grid gap-1.5 sm:grid-cols-2">
                {branches.map((b) => (
                  <label
                    key={b.id}
                    className="flex items-center gap-2 text-sm text-[var(--color-fg)]"
                  >
                    <input
                      type="checkbox"
                      checked={form.branchIds.includes(b.id)}
                      onChange={() => toggleBranch(b.id)}
                    />
                    {b.name}
                    <span className="text-xs text-[var(--color-fg-subtle)]">{b.code}</span>
                  </label>
                ))}
                {form.branchIds.length === 0 && (
                  <p className="text-xs text-[var(--color-danger)] sm:col-span-2">
                    Pick at least one branch, or choose “All branches”.
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div>
        <p className="mb-2 text-xs font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
          Professional details
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Designation"
            name="designation"
            value={form.designation}
            onChange={(e) => set({ designation: e.target.value })}
            hint="e.g. Senior Consultant, Staff Nurse"
          />
          <Field
            label="Department"
            name="department"
            value={form.department}
            onChange={(e) => set({ department: e.target.value })}
            hint="e.g. Cardiology, Radiology"
          />
          {hasSpecialty && (
            <Field
              label="Specialty"
              name="specialty"
              value={form.specialty}
              onChange={(e) => set({ specialty: e.target.value })}
              hint="e.g. Cardiology, Orthopaedics"
            />
          )}
          {hasSpecialty && (
            <Field
              label="Consultation fee (₹)"
              name="consultationFee"
              type="number"
              min={0}
              step="1"
              value={form.consultationFee}
              onChange={(e) => set({ consultationFee: e.target.value })}
              hint="Charged when a patient starts a visit with them. Blank = hospital rate."
            />
          )}
          {hasSpecialty && (
            <label className="flex items-start gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
              <input
                type="checkbox"
                checked={form.showOnPublicSite}
                onChange={(e) => set({ showOnPublicSite: e.target.checked })}
                className="mt-0.5 h-4 w-4"
              />
              <span className="text-sm text-[var(--color-fg)]">
                Show on the public website
                <span className="mt-0.5 block text-xs text-[var(--color-fg-muted)]">
                  Features this doctor (name and specialty only) in the Doctors section of your
                  hospital&apos;s public site.
                </span>
              </span>
            </label>
          )}
          {/* Offered to EVERY role, not just clinical ones: the front desk signs receipts, and a
              receipt with a name and no signature is the document a patient disputes. */}
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-subtle)] p-3">
            <span className="text-sm font-medium text-[var(--color-fg)]">Signature</span>
            <span className="mt-0.5 block text-xs text-[var(--color-fg-muted)]">
              A scanned signature (PNG/JPG under ~200&nbsp;KB) — printed on the documents this
              person signs: OPD slips for a doctor, payment receipts for whoever takes the money.
              Optional; without one those documents print a blank line to sign by hand.
            </span>
            <div className="mt-2 flex items-center gap-3">
              {form.signature.startsWith("data:image") ? (
                <img
                  src={form.signature}
                  alt="Staff signature"
                  className="h-12 rounded border border-[var(--color-border)] bg-white object-contain px-2"
                />
              ) : (
                <span className="text-xs text-[var(--color-fg-subtle)]">None uploaded</span>
              )}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="text-xs"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  if (file.size > 200_000) {
                    setSignatureError(
                      `That image is ${String(Math.round(file.size / 1024))} KB — please use one under 200 KB.`,
                    );
                    return;
                  }
                  setSignatureError(null);
                  const reader = new FileReader();
                  reader.onload = () => set({ signature: String(reader.result) });
                  reader.readAsDataURL(file);
                }}
              />
            </div>
            {signatureError && (
              <p className="mt-2 text-xs text-[var(--color-danger)]">{signatureError}</p>
            )}
          </div>
          {isClinical && (
            <Field
              label="Qualification"
              name="qualification"
              value={form.qualification}
              onChange={(e) => set({ qualification: e.target.value })}
              hint="e.g. MBBS, MD"
            />
          )}
          {isClinical && (
            <Field
              label="Registration / licence no."
              name="registrationNo"
              value={form.registrationNo}
              onChange={(e) => set({ registrationNo: e.target.value })}
              hint="Medical council / professional registration"
            />
          )}
          <Field
            label="Phone"
            name="phone"
            value={form.phone}
            onChange={(e) => set({ phone: e.target.value })}
          />
          {labelledSelect(
            "Gender",
            form.gender,
            (v) => set({ gender: v }),
            STAFF_GENDERS.map((g) => ({ value: g, label: g })),
          )}
          <Field
            label="Date of birth"
            name="dateOfBirth"
            type="date"
            value={form.dateOfBirth}
            onChange={(e) => set({ dateOfBirth: e.target.value })}
          />
          <Field
            label="Joining date"
            name="joiningDate"
            type="date"
            value={form.joiningDate}
            onChange={(e) => set({ joiningDate: e.target.value })}
          />
          <Field
            label="Emergency contact name"
            name="emergencyContactName"
            value={form.emergencyContactName}
            onChange={(e) => set({ emergencyContactName: e.target.value })}
          />
          <Field
            label="Emergency contact phone"
            name="emergencyContactPhone"
            value={form.emergencyContactPhone}
            onChange={(e) => set({ emergencyContactPhone: e.target.value })}
          />
        </div>
        <div className="mt-4">
          <Field
            label="Address"
            name="address"
            value={form.address}
            onChange={(e) => set({ address: e.target.value })}
          />
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" loading={saving}>
          {mode === "create" ? "Create account" : "Save changes"}
        </Button>
        {mode === "create" && (
          <span className="text-xs text-[var(--color-fg-muted)]">
            A temporary password is generated and shown once.
          </span>
        )}
      </div>
    </form>
  );
}

function DetailRow({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-4 border-b border-[var(--color-border)] py-2 last:border-0">
      <span className="text-sm text-[var(--color-fg-muted)]">{label}</span>
      <span className="text-right text-sm font-medium text-[var(--color-fg)]">{value}</span>
    </div>
  );
}

/**
 * The sites a member of staff works at, named.
 *
 * An EMPTY binding is the HOSPITAL-WIDE one, not "nowhere" — and that distinction is the whole
 * reason this is worth showing in the list rather than only in the detail panel. A director bound
 * to nothing works everywhere; a receptionist bound to one site works there only; anyone bound to
 * two or more is genuinely shared between sites. Reading the directory, those three look identical
 * until something says so.
 *
 * Falls back to the raw id if a branch has since been renamed away, because a row that silently
 * drops a binding it cannot resolve would under-report where someone works.
 */
function branchNamesOf(member: StaffMember, branches: Branch[]): string[] {
  return member.branchIds.map((id) => branches.find((b) => b.id === id)?.name ?? id);
}

function StaffDetail({ member, branches }: { member: StaffMember; branches: Branch[] }) {
  const p = member.profile ?? {};
  // Only worth showing once a hospital actually has branches.
  const branchAccess =
    branches.length > 1
      ? member.branchIds.length === 0
        ? "All branches"
        : branchNamesOf(member, branches).join(", ")
      : undefined;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[var(--color-brand-600)] text-lg font-semibold text-[var(--color-on-accent)]">
          {member.name.charAt(0).toUpperCase()}
        </div>
        <div>
          <p className="font-semibold text-[var(--color-fg)]">{member.name}</p>
          <p className="text-xs text-[var(--color-fg-muted)]">{member.email}</p>
        </div>
        <div className="ml-auto flex gap-1.5">
          {member.roles.map((r) => (
            <Badge key={r} tone="brand">
              {r}
            </Badge>
          ))}
          <Badge tone={statusTone(member.status)}>{member.status}</Badge>
        </div>
      </div>
      <div>
        <DetailRow label="Employee ID" value={member.employeeId} />
        <DetailRow label="Designation" value={p.designation} />
        <DetailRow label="Department" value={p.department} />
        <DetailRow label="Specialty" value={p.specialty} />
        <DetailRow
          label="Consultation fee"
          value={p.consultationFee !== undefined ? rupees(p.consultationFee) : undefined}
        />
        <DetailRow label="Qualification" value={p.qualification} />
        <DetailRow label="Registration / licence" value={p.registrationNo} />
        <DetailRow label="Phone" value={member.phone} />
        <DetailRow label="Gender" value={p.gender} />
        <DetailRow label="Date of birth" value={p.dateOfBirth} />
        <DetailRow label="Joining date" value={p.joiningDate} />
        <DetailRow label="Address" value={p.address} />
        <DetailRow label="Emergency contact" value={p.emergencyContactName} />
        <DetailRow label="Emergency phone" value={p.emergencyContactPhone} />
        <DetailRow label="Branch access" value={branchAccess} />
        <DetailRow label="Two-step verification" value={member.mfaEnabled ? "On" : "Off"} />
        <DetailRow
          label="Last sign-in"
          value={member.lastLoginAt ? new Date(member.lastLoginAt).toLocaleString() : "Never"}
        />
      </div>
    </div>
  );
}

type StatusFilter = "all" | "active" | "disabled";

/**
 * One page, deliberately: the directory of a hospital is hundreds of people at most, and paging
 * a list somebody is scanning for a colleague costs more than it saves. Named so the count row
 * can tell the truth if a hospital ever outgrows it.
 */
const LIMIT = 100;

function StaffDirectory() {
  const { api, can, user } = useAuth();
  // The site the header is currently pointing at — the third thing filtering this list, and the
  // one with no other explanation on screen.
  const { active: activeBranch } = useBranch();
  const activeBranchName = activeBranch?.name;

  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [total, setTotal] = useState(0);
  const [roles, setRoles] = useState<Role[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});
  const [created, setCreated] = useState<{ email: string; password?: string } | null>(null);

  const [viewing, setViewing] = useState<StaffMember | null>(null);
  const [editing, setEditing] = useState<StaffMember | null>(null);
  /**
   * The account action awaiting confirmation. Both end somebody's sessions mid-shift, so both are
   * asked in the application rather than through `window.confirm` — which cannot name the person
   * in a styled, screen-readable way and which the browser may refuse to show at all.
   */
  const [confirming, setConfirming] = useState<{
    member: StaffMember;
    action: "disable" | "reset";
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.listStaff({
        limit: LIMIT,
        ...(query ? { q: query } : {}),
        ...(statusFilter !== "all" ? { status: statusFilter } : {}),
      });
      setStaff(page.items);
      // `total` is what the server counted; falling back to the page length keeps the row honest
      // rather than showing 0 if a future endpoint stops sending it.
      setTotal(page.meta.total ?? page.items.length);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load staff.");
    } finally {
      setLoading(false);
    }
  }, [api, query, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!can("role:manage")) return;
    void api
      .listRoles()
      .then(setRoles)
      .catch(() => setRoles([]));
  }, [api, can]);

  // The branch list drives the "which sites?" picker. It needs `branch:manage`; an admin who
  // cannot see branches simply gets no branch picker and every hire stays hospital-wide.
  useEffect(() => {
    if (!can("branch:manage")) return;
    void api
      .listBranches()
      .then((all) => setBranches(all.filter((b) => b.status === "active")))
      .catch(() => setBranches([]));
  }, [api, can]);

  async function create(f: FormState) {
    setSaving(true);
    setFieldErrors({});
    setError(null);
    try {
      const profile = profileFromForm(f);
      const result = await api.createStaff({
        name: f.name,
        email: f.email,
        ...(f.role ? { roles: [f.role] } : {}),
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
        ...(f.employeeId.trim() ? { employeeId: f.employeeId.trim() } : {}),
        ...(Object.keys(profile).length ? { profile } : {}),
      });
      // Confine to specific branches, if chosen. "All branches" needs no call — a new binding is
      // hospital-wide by default. Only meaningful once the role and >1 branch both exist.
      if (f.role && !f.allBranches && f.branchIds.length > 0) {
        await api.assignStaffRole(result.user.id, f.role, f.branchIds);
      }
      setCreated({
        email: result.user.email,
        ...(result.temporaryPassword ? { password: result.temporaryPassword } : {}),
      });
      setShowCreate(false);
      await load();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setFieldErrors(err.fieldErrors);
        if (Object.keys(err.fieldErrors).length === 0) setError(err.message);
      } else {
        setError("Could not create the account.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(f: FormState) {
    if (!editing) return;

    // Guard the one invalid branch state before we touch the server.
    if (branches.length > 1 && !f.allBranches && f.branchIds.length === 0) {
      setError("Pick at least one branch, or choose “All branches”.");
      return;
    }

    setSaving(true);
    setFieldErrors({});
    try {
      await api.updateStaff(editing.id, {
        name: f.name,
        ...(f.phone.trim() ? { phone: f.phone.trim() } : {}),
        ...(f.employeeId.trim() ? { employeeId: f.employeeId.trim() } : {}),
        profile: profileFromForm(f),
      });
      // Update branch access on the member's role. Re-assigning the same role updates the binding;
      // an empty list resets it to "all branches". Skipped for a member with no role to bind to.
      const role = editing.roles[0];
      if (role && branches.length > 1) {
        await api.assignStaffRole(editing.id, role, f.allBranches ? [] : f.branchIds);
      }
      setEditing(null);
      await load();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setFieldErrors(err.fieldErrors);
        if (Object.keys(err.fieldErrors).length === 0) setError(err.message);
      } else {
        setError("Could not save changes.");
      }
    } finally {
      setSaving(false);
    }
  }

  /** Re-ENABLING is not asked about — it restores access rather than taking it away. */
  async function toggleStatus(member: StaffMember) {
    const next = member.status === "active" ? "disabled" : "active";
    if (next === "disabled") {
      setConfirming({ member, action: "disable" });
      return;
    }
    await setStatus(member, next);
  }

  async function setStatus(member: StaffMember, next: "active" | "disabled") {
    try {
      await api.setStaffStatus(member.id, next);
      await load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not update the account.");
    } finally {
      setConfirming(null);
    }
  }

  async function resetPassword(member: StaffMember) {
    try {
      const res = await api.resetStaffPassword(member.id);
      setCreated({
        email: member.email,
        ...(res.temporaryPassword ? { password: res.temporaryPassword } : {}),
      });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not reset the password.");
    } finally {
      setConfirming(null);
    }
  }

  const roleName = useMemo(() => new Map(roles.map((r) => [r.code, r.name])), [roles]);

  const columns: Column<StaffMember>[] = [
    {
      key: "name",
      header: "Name",
      render: (member) => (
        <>
          <p className="font-medium text-[var(--color-fg)]">{member.name}</p>
          <p className="text-xs text-[var(--color-fg-muted)]">{member.email}</p>
        </>
      ),
    },
    {
      key: "role",
      header: "Role",
      render: (member) => (
        <div className="flex flex-wrap gap-1">
          {member.roles.length > 0 ? (
            member.roles.map((r) => (
              <Badge key={r} tone="brand">
                {roleName.get(r) ?? r}
              </Badge>
            ))
          ) : (
            <span className="text-xs text-[var(--color-fg-subtle)]">none</span>
          )}
        </div>
      ),
    },
    /**
     * Only once a hospital has more than one site — a single-branch hospital would get a column
     * that says the same thing on every row. Matches the create/edit form, which hides the branch
     * control on the same condition.
     */
    ...(branches.length > 1
      ? ([
          {
            key: "branch",
            header: "Branch",
            render: (member: StaffMember) =>
              member.branchIds.length === 0 ? (
                // The hospital-wide binding. Toned differently from a named site because it is a
                // different KIND of answer, not another place: this person works at all of them.
                <Badge tone="info">All branches</Badge>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {branchNamesOf(member, branches).map((name) => (
                    <Badge key={name} tone="neutral">
                      {name}
                    </Badge>
                  ))}
                </div>
              ),
          },
        ] satisfies Column<StaffMember>[])
      : []),
    {
      key: "dept",
      header: "Department / specialty",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: (member) => {
        const p = member.profile ?? {};
        return [p.specialty, p.department].filter(Boolean).join(" · ") || "—";
      },
    },
    {
      key: "phone",
      header: "Phone",
      cellClassName: "text-[var(--color-fg-muted)]",
      render: (member) => member.phone ?? "—",
    },
    {
      key: "status",
      header: "Status",
      render: (member) => <Badge tone={statusTone(member.status)}>{member.status}</Badge>,
    },
    {
      key: "actions",
      header: "Actions",
      align: "right",
      render: (member) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" className="text-xs" onClick={() => setViewing(member)}>
            View
          </Button>
          <PermissionGate can={can} permission="user:update">
            <Button
              variant="ghost"
              className="text-xs"
              onClick={() => {
                setFieldErrors({});
                setEditing(member);
              }}
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              className="text-xs"
              onClick={() => setConfirming({ member, action: "reset" })}
            >
              Reset password
            </Button>
          </PermissionGate>
          <PermissionGate can={can} permission="user:deactivate">
            {member.id !== user?.id && (
              <Button
                variant="ghost"
                className={`text-xs ${member.status === "active" ? "text-[var(--color-danger)]" : ""}`}
                onClick={() => void toggleStatus(member)}
              >
                {member.status === "active" ? "Disable" : "Enable"}
              </Button>
            )}
          </PermissionGate>
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Staff</h1>
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            Everyone with a login at this hospital. Add someone, edit their details, or disable a
            login the moment they leave.
          </p>
        </div>
        <PermissionGate can={can} permission="user:create">
          <Button onClick={() => setShowCreate(true)}>Add staff</Button>
        </PermissionGate>
      </div>

      {created && (
        <Alert tone="success" title="Account ready">
          <p>
            <strong>{created.email}</strong> can sign in now.
          </p>
          {created.password && (
            <div className="mt-2">
              <p className="mb-1">
                Give them this temporary password. It is shown <strong>once</strong> — we store only
                its hash, so it cannot be retrieved again. They must change it at first sign-in.
              </p>
              <code className="mt-1 inline-block rounded-md bg-[var(--color-bg-elevated)] px-3 py-1.5 font-mono text-sm">
                {created.password}
              </code>
            </div>
          )}
          <button onClick={() => setCreated(null)} className="mt-2 text-xs underline" type="button">
            Dismiss
          </button>
        </Alert>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or email…"
            className="w-full max-w-xs rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2 text-sm text-[var(--color-fg)] outline-none focus:border-[var(--color-brand-500)]"
          />
          <div className="flex gap-1">
            {(["all", "active", "disabled"] as StatusFilter[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded-lg px-3 py-1.5 text-sm capitalize transition-colors ${
                  statusFilter === s
                    ? "bg-[var(--color-brand-600)] text-[var(--color-on-accent)]"
                    : "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]"
                }`}
              >
                {s}
              </button>
            ))}
          </div>

          {/*
            The count, and it is not decoration. This list is filtered by three things at once —
            the search box, the status chips, and (since the directory became branch-scoped) the
            site in the header. A directory that silently returns a subset looks exactly like a
            directory that is complete, which is the confusion that prompted this: the same twelve
            faces at both sites, with nothing on screen to say what the list was answering.

            So it names the scope rather than only the number. `LIMIT` is the ceiling the fetch
            asks for; if a hospital ever exceeds it the row says so instead of quietly stopping at
            a hundred, because "100 staff" and "100 of 137 staff" are different facts.
          */}
          {!loading && (
            <p className="ml-auto text-sm text-[var(--color-fg-muted)]">
              {total > LIMIT ? (
                <>
                  Showing <span className="font-medium text-[var(--color-fg)]">{staff.length}</span>{" "}
                  of <span className="font-medium text-[var(--color-fg)]">{total}</span>
                </>
              ) : (
                <>
                  <span className="font-medium text-[var(--color-fg)]">{total}</span>{" "}
                  {total === 1 ? "person" : "people"}
                </>
              )}
              {query || statusFilter !== "all" ? " matching" : ""}
              {activeBranchName ? ` at ${activeBranchName}` : " across all branches"}
            </p>
          )}
        </div>
      </Card>

      <DataTable<StaffMember>
        columns={columns}
        rows={loading ? [] : staff}
        keyOf={(member) => member.id}
        loading={loading}
        empty="Nobody matches."
      />

      {showCreate && (
        <Modal title="Add staff" onClose={() => setShowCreate(false)}>
          <StaffForm
            mode="create"
            initial={EMPTY_FORM}
            roles={roles}
            branches={branches}
            onSubmit={(f) => void create(f)}
            saving={saving}
            fieldErrors={fieldErrors}
          />
        </Modal>
      )}

      {editing && (
        <Modal title={`Edit ${editing.name}`} onClose={() => setEditing(null)}>
          <StaffForm
            mode="edit"
            initial={formFromMember(editing)}
            roles={roles}
            branches={branches}
            onSubmit={(f) => void saveEdit(f)}
            saving={saving}
            fieldErrors={fieldErrors}
          />
        </Modal>
      )}

      {viewing && (
        <Modal title="Staff profile" onClose={() => setViewing(null)}>
          <StaffDetail member={viewing} branches={branches} />
        </Modal>
      )}

      {confirming?.action === "disable" && (
        <ConfirmDialog
          title={`Disable ${confirming.member.name}'s login?`}
          confirmLabel="Disable the login"
          cancelLabel="Leave it active"
          tone="danger"
          onConfirm={() => void setStatus(confirming.member, "disabled")}
          onCancel={() => setConfirming(null)}
        >
          <p>
            Every session they have open ends <strong>immediately</strong> — including one part-way
            through charting. The account can be re-enabled from this screen afterwards.
          </p>
        </ConfirmDialog>
      )}

      {confirming?.action === "reset" && (
        <ConfirmDialog
          title={`Reset ${confirming.member.name}'s password?`}
          confirmLabel="Reset the password"
          cancelLabel="Leave it alone"
          tone="danger"
          onConfirm={() => void resetPassword(confirming.member)}
          onCancel={() => setConfirming(null)}
        >
          <p>
            Their current sessions end and a temporary password is shown <em>once</em> on this
            screen — there is no way to see it again, so hand it over before closing the dialog.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

export default function Page() {
  return <StaffDirectory />;
}
