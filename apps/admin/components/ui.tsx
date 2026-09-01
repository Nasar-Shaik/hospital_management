"use client";

/**
 * Operator-console UI primitives.
 *
 * The hospital app has its own `components/ui.tsx`; the console is a separate deployable, so it
 * carries its own small set — but styled from the SAME shared tokens (`@medicore/ui`) and the same
 * "calm premium" language, so the two products look like one company's work. Only what the console
 * actually uses lives here.
 */
import {
  useEffect,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

const FOCUS =
  "outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]/45 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--color-bg)]";

export function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  loading?: boolean;
}) {
  const variants: Record<string, string> = {
    primary:
      "bg-[var(--color-brand-600)] text-[var(--color-on-accent)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-brand-700)]",
    secondary:
      "bg-[var(--color-bg-elevated)] text-[var(--color-fg)] border border-[var(--color-border-strong)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-bg-subtle)]",
    danger:
      "bg-[var(--color-danger)] text-[var(--color-on-accent)] shadow-[var(--shadow-xs)] hover:opacity-90",
    ghost:
      "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-fg)]",
  };
  const sizes: Record<string, string> = {
    sm: "px-3 py-1.5 text-xs gap-1.5",
    md: "px-4 py-2.5 text-sm gap-2",
  };
  return (
    <button
      {...props}
      disabled={props.disabled ?? loading}
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-[transform,background-color,box-shadow,opacity] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:-translate-y-px active:translate-y-0 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 ${FOCUS} ${sizes[size]} ${variants[variant]} ${className}`}
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

export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "brand" | "info";
  dot?: boolean;
}) {
  const tones: Record<string, { chip: string; dot: string }> = {
    neutral: {
      chip: "bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)]",
      dot: "bg-[var(--color-fg-subtle)]",
    },
    success: {
      chip: "bg-[var(--color-success-bg)] text-[var(--color-success)]",
      dot: "bg-[var(--color-success)]",
    },
    warning: {
      chip: "bg-[var(--color-warning-bg)] text-[var(--color-warning)]",
      dot: "bg-[var(--color-warning)]",
    },
    danger: {
      chip: "bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
      dot: "bg-[var(--color-danger)]",
    },
    brand: {
      chip: "bg-[var(--color-brand-50)] text-[var(--color-brand-700)]",
      dot: "bg-[var(--color-brand-600)]",
    },
    info: {
      chip: "bg-[var(--color-info-bg)] text-[var(--color-info)]",
      dot: "bg-[var(--color-info)]",
    },
  };
  const t = tones[tone] ?? tones.neutral!;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ${t.chip}`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} aria-hidden />}
      {children}
    </span>
  );
}

export function Field({
  label,
  error,
  hint,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{label}</span>
      <input
        {...props}
        aria-invalid={error ? true : undefined}
        className={`w-full rounded-lg border bg-[var(--color-bg-elevated)] px-3.5 py-2.5 text-sm shadow-[var(--shadow-xs)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] outline-none placeholder:text-[var(--color-fg-subtle)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]/30 ${
          error
            ? "border-[var(--color-danger)]"
            : "border-[var(--color-border-strong)] focus-visible:border-[var(--color-brand-500)]"
        } ${className}`}
      />
      {error && <span className="mt-1.5 block text-sm text-[var(--color-danger)]">{error}</span>}
      {hint && !error && (
        <span className="mt-1.5 block text-xs text-[var(--color-fg-muted)]">{hint}</span>
      )}
    </label>
  );
}

/** Close on Escape + lock the body scroll while open — shared by the modal and the drawer. */
function useOverlay(onClose: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
}

/** A centered modal — for the create form and confirmations. */
export function Modal({
  title,
  onClose,
  children,
  width = "max-w-2xl",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  useOverlay(onClose);
  if (typeof document === "undefined") return null;
  // Portalled to <body> so it clears the sticky top bar's stacking context (see the web Modal).
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal
    >
      <div
        className="mc-fade-in absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        className={`mc-scale-in relative w-full ${width} rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-xl)]`}
      >
        <div className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
          <h2 className="text-base font-semibold text-[var(--color-fg)]">{title}</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-fg)]"
            aria-label="Close"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[75vh] overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** A right-side slide-in panel — for the tenant detail + configuration. */
export function Drawer({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useOverlay(onClose);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal>
      <div
        className="mc-fade-in absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div className="mc-drawer-in-right absolute inset-y-0 right-0 flex w-full max-w-xl flex-col border-l border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-xl)]">
        <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-6 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-[var(--color-fg)]">{title}</h2>
            {subtitle && (
              <div className="mt-0.5 text-sm text-[var(--color-fg-muted)]">{subtitle}</div>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-1.5 text-[var(--color-fg-subtle)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-fg)]"
            aria-label="Close"
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

/** A deliberate confirmation — the in-app replacement for `window.confirm`. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Confirm",
  tone = "danger",
  busy = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel} width="max-w-md">
      <div className="space-y-5">
        <div className="text-sm text-[var(--color-fg-muted)]">{body}</div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            loading={busy}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
