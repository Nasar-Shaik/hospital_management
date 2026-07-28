"use client";

/**
 * Hospital profile (Module B1) — the institution's own official identity.
 *
 * This is the legal/administrative face of the hospital (registered name, licence and tax numbers,
 * accreditations, registered office, the person in charge) — distinct from the public marketing
 * site (`/settings/site`) and the brand logo/colour. It is a singleton: one profile per hospital,
 * upserted. Gated on `hospital:manage`; a blank field is saved as "cleared".
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { type HospitalProfile, type OwnershipType } from "@medicore/api-client";
import { useAuth } from "../../../components/AuthProvider";
import { Alert, Button, Card, ErrorAlert, Field } from "../../../components/ui";

const OWNERSHIP: { value: OwnershipType; label: string }[] = [
  { value: "government", label: "Government" },
  { value: "private", label: "Private" },
  { value: "trust", label: "Trust" },
  { value: "charitable", label: "Charitable" },
  { value: "corporate", label: "Corporate" },
];

interface FormState {
  legalName: string;
  registrationNumber: string;
  taxId: string;
  accreditations: string;
  establishedYear: string;
  ownershipType: string;
  licensedBeds: string;
  address: string;
  officialEmail: string;
  officialPhone: string;
  website: string;
  headName: string;
  headTitle: string;
}

const EMPTY: FormState = {
  legalName: "",
  registrationNumber: "",
  taxId: "",
  accreditations: "",
  establishedYear: "",
  ownershipType: "",
  licensedBeds: "",
  address: "",
  officialEmail: "",
  officialPhone: "",
  website: "",
  headName: "",
  headTitle: "",
};

function fromProfile(p: HospitalProfile): FormState {
  return {
    legalName: p.legalName ?? "",
    registrationNumber: p.registrationNumber ?? "",
    taxId: p.taxId ?? "",
    accreditations: (p.accreditations ?? []).join(", "),
    establishedYear: p.establishedYear != null ? String(p.establishedYear) : "",
    ownershipType: p.ownershipType ?? "",
    licensedBeds: p.licensedBeds != null ? String(p.licensedBeds) : "",
    address: p.address ?? "",
    officialEmail: p.officialEmail ?? "",
    officialPhone: p.officialPhone ?? "",
    website: p.website ?? "",
    headName: p.headName ?? "",
    headTitle: p.headTitle ?? "",
  };
}

/** Only send fields that carry a value; blanks are omitted (the API clears them). */
function toProfile(f: FormState): HospitalProfile {
  const out: HospitalProfile = {};
  if (f.legalName.trim()) out.legalName = f.legalName.trim();
  if (f.registrationNumber.trim()) out.registrationNumber = f.registrationNumber.trim();
  if (f.taxId.trim()) out.taxId = f.taxId.trim();
  const accs = f.accreditations
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (accs.length) out.accreditations = accs;
  if (f.establishedYear.trim()) out.establishedYear = Number(f.establishedYear);
  if (f.ownershipType) out.ownershipType = f.ownershipType as OwnershipType;
  if (f.licensedBeds.trim()) out.licensedBeds = Number(f.licensedBeds);
  if (f.address.trim()) out.address = f.address.trim();
  if (f.officialEmail.trim()) out.officialEmail = f.officialEmail.trim();
  if (f.officialPhone.trim()) out.officialPhone = f.officialPhone.trim();
  if (f.website.trim()) out.website = f.website.trim();
  if (f.headName.trim()) out.headName = f.headName.trim();
  if (f.headTitle.trim()) out.headTitle = f.headTitle.trim();
  return out;
}

function HospitalProfilePage() {
  const { api, can } = useAuth();
  const allowed = can("hospital:manage");

  const [form, setForm] = useState<FormState>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (patch: Partial<FormState>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  };

  const load = useCallback(() => {
    setLoading(true);
    api
      .getHospitalProfile()
      .then((p) => setForm(fromProfile(p)))
      .catch((e: unknown) => setError(e))
      .finally(() => setLoading(false));
  }, [api]);

  useEffect(load, [load]);

  function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    api
      .saveHospitalProfile(toProfile(form))
      .then((p) => {
        setForm(fromProfile(p));
        setSaved(true);
      })
      .catch((err: unknown) => setError(err))
      .finally(() => setSaving(false));
  }

  if (!allowed) {
    return (
      <Card className="mx-auto max-w-lg p-8 text-center text-sm text-[var(--color-fg-muted)]">
        You do not have permission to edit the hospital profile.
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Hospital profile</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          The institution&rsquo;s official identity — its legal name, registration and
          accreditation. Printed on official documents; kept separate from your public website and
          branding.
        </p>
      </div>

      {error != null && <ErrorAlert error={error} fallback="Could not load or save the profile." />}
      {saved && <Alert tone="success">Hospital profile saved.</Alert>}

      <form onSubmit={submit} className="space-y-6">
        <Card className="space-y-5 p-6">
          <h2 className="text-sm font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
            Identity
          </h2>
          <Field
            label="Registered legal name"
            value={form.legalName}
            onChange={(e) => set({ legalName: e.target.value })}
            placeholder="Sunrise Multispeciality Hospital Pvt. Ltd."
            disabled={loading}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Registration number"
              value={form.registrationNumber}
              onChange={(e) => set({ registrationNumber: e.target.value })}
              disabled={loading}
            />
            <Field
              label="Tax ID (GST / PAN)"
              value={form.taxId}
              onChange={(e) => set({ taxId: e.target.value })}
              disabled={loading}
            />
            <Field
              label="Established year"
              type="number"
              value={form.establishedYear}
              onChange={(e) => set({ establishedYear: e.target.value })}
              placeholder="1998"
              disabled={loading}
            />
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">
                Ownership
              </span>
              <select
                className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm text-[var(--color-fg)]"
                value={form.ownershipType}
                onChange={(e) => set({ ownershipType: e.target.value })}
                disabled={loading}
              >
                <option value="">— Not set —</option>
                {OWNERSHIP.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="Licensed beds"
              type="number"
              value={form.licensedBeds}
              onChange={(e) => set({ licensedBeds: e.target.value })}
              hint="Informational — distinct from the live bed board."
              disabled={loading}
            />
          </div>
          <Field
            label="Accreditations"
            value={form.accreditations}
            onChange={(e) => set({ accreditations: e.target.value })}
            placeholder="NABH, NABL, ISO 9001"
            hint="Comma-separated."
            disabled={loading}
          />
        </Card>

        <Card className="space-y-5 p-6">
          <h2 className="text-sm font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
            Registered office
          </h2>
          <Field
            label="Address"
            value={form.address}
            onChange={(e) => set({ address: e.target.value })}
            disabled={loading}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Official email"
              type="email"
              value={form.officialEmail}
              onChange={(e) => set({ officialEmail: e.target.value })}
              disabled={loading}
            />
            <Field
              label="Official phone"
              value={form.officialPhone}
              onChange={(e) => set({ officialPhone: e.target.value })}
              disabled={loading}
            />
            <Field
              label="Website"
              value={form.website}
              onChange={(e) => set({ website: e.target.value })}
              placeholder="https://…"
              disabled={loading}
            />
          </div>
        </Card>

        <Card className="space-y-5 p-6">
          <h2 className="text-sm font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
            Person in charge
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Name"
              value={form.headName}
              onChange={(e) => set({ headName: e.target.value })}
              placeholder="Dr. A. Sharma"
              disabled={loading}
            />
            <Field
              label="Title"
              value={form.headTitle}
              onChange={(e) => set({ headTitle: e.target.value })}
              placeholder="Medical Director"
              disabled={loading}
            />
          </div>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={loading}>
            Save profile
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function Page() {
  return <HospitalProfilePage />;
}
