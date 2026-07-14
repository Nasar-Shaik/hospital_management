"use client";

/**
 * Shared UI primitives (Doc 08).
 *
 * Built on the semantic design tokens in `@medicore/ui`, never on raw palette
 * values — so a hospital's brand colour changes one variable and the whole app
 * follows. Semantic colours (success/warning/danger) are sacred: danger means
 * "this could harm someone", not "this button is red".
 */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

export function Button({
  children,
  variant = "primary",
  loading = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
}) {
  const styles: Record<string, string> = {
    primary:
      "bg-[var(--color-brand-600)] text-[var(--color-on-accent)] hover:bg-[var(--color-brand-700)] disabled:bg-[var(--color-brand-600)]/50",
    secondary:
      "bg-[var(--color-bg-elevated)] text-[var(--color-fg)] border border-[var(--color-border-strong)] hover:bg-[var(--color-bg-subtle)]",
    danger: "bg-[var(--color-danger)] text-[var(--color-on-accent)] hover:opacity-90",
    ghost: "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)]",
  };

  return (
    <button
      {...props}
      disabled={props.disabled ?? loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles[variant]} ${className}`}
    >
      {loading && (
        <span
          aria-hidden
          className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      )}
      {children}
    </button>
  );
}

export function Field({
  label,
  error,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{label}</span>
      <input
        {...props}
        // Errors are announced, not just coloured — a red border is invisible to
        // a screen reader and to a colour-blind user (Doc 08 accessibility).
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${props.name ?? label}-error` : undefined}
        className={`w-full rounded-lg border bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-[var(--color-fg-subtle)] focus:ring-2 focus:ring-[var(--color-brand-500)]/30 ${
          error
            ? "border-[var(--color-danger)] focus:border-[var(--color-danger)]"
            : "border-[var(--color-border-strong)] focus:border-[var(--color-brand-500)]"
        }`}
      />
      {error && (
        <span
          id={`${props.name ?? label}-error`}
          role="alert"
          className="mt-1.5 block text-sm text-[var(--color-danger)]"
        >
          {error}
        </span>
      )}
      {hint && !error && (
        <span className="mt-1.5 block text-xs text-[var(--color-fg-muted)]">{hint}</span>
      )}
    </label>
  );
}

export function Alert({
  tone = "danger",
  title,
  children,
}: {
  tone?: "danger" | "warning" | "success" | "info";
  title?: string;
  children: ReactNode;
}) {
  const tones: Record<string, string> = {
    danger:
      "bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger)]/20",
    warning:
      "bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-[var(--color-warning)]/20",
    success:
      "bg-[var(--color-success-bg)] text-[var(--color-success)] border-[var(--color-success)]/20",
    info: "bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)] border-[var(--color-border)]",
  };

  return (
    <div role="alert" className={`rounded-lg border px-4 py-3 text-sm ${tones[tone]}`}>
      {title && <p className="mb-0.5 font-semibold">{title}</p>}
      {children}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] ${className}`}
    >
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "danger" | "brand";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)]",
    success: "bg-[var(--color-success-bg)] text-[var(--color-success)]",
    danger: "bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
    brand: "bg-[var(--color-brand-50)] text-[var(--color-brand-700)]",
  };
  return (
    <span
      className={`inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Hides UI the user cannot use. Convenience ONLY — the server independently
 * refuses the action (Constitution §3.6). Never rely on this to protect anything.
 */
export function PermissionGate({
  can,
  permission,
  children,
}: {
  can: (p: string) => boolean;
  permission: string;
  children: ReactNode;
}) {
  return can(permission) ? <>{children}</> : null;
}
