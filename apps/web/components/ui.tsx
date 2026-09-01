"use client";

/**
 * Shared UI primitives (Doc 08).
 *
 * Built on the semantic design tokens in `@medicore/ui`, never on raw palette values — so a
 * hospital's brand colour changes one variable and the whole app follows. Semantic colours
 * (success/warning/danger) are sacred: danger means "this could harm someone", not "this button is
 * red".
 *
 * ── THE CALM PREMIUM BAR ─────────────────────────────────────────────────────
 * These primitives carry the app's whole look, so the polish lives HERE and cascades to every
 * screen. The motion is deliberately quiet — a 2px hover lift, a 2% press, a soft ring — because
 * this is an interface clinicians stare at for a twelve-hour shift, not a landing page. Every
 * transition rides the shared `--dur-*` / `--ease-*` tokens and collapses under
 * `prefers-reduced-motion` (globals.css).
 */
import {
  useEffect,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { describeError } from "../lib/errors";

/** The shared focus ring — one look for every keyboard-focused control. */
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
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}) {
  const variants: Record<string, string> = {
    primary:
      "bg-[var(--color-brand-600)] text-[var(--color-on-accent)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-brand-700)] hover:shadow-[var(--shadow-sm)] disabled:bg-[var(--color-brand-600)]/50 disabled:shadow-none",
    secondary:
      "bg-[var(--color-bg-elevated)] text-[var(--color-fg)] border border-[var(--color-border-strong)] shadow-[var(--shadow-xs)] hover:bg-[var(--color-bg-subtle)] hover:border-[var(--color-border-strong)]",
    danger:
      "bg-[var(--color-danger)] text-[var(--color-on-accent)] shadow-[var(--shadow-xs)] hover:opacity-90",
    ghost:
      "text-[var(--color-fg-muted)] hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-fg)]",
  };
  const sizes: Record<string, string> = {
    sm: "px-3 py-1.5 text-xs gap-1.5 rounded-lg",
    md: "px-4 py-2.5 text-sm gap-2 rounded-lg",
    lg: "px-5 py-3 text-sm gap-2 rounded-xl",
  };

  return (
    <button
      {...props}
      disabled={props.disabled ?? loading}
      className={`group inline-flex items-center justify-center font-medium transition-[transform,background-color,box-shadow,opacity,border-color] duration-[var(--dur-fast)] ease-[var(--ease-standard)] hover:-translate-y-px active:translate-y-0 active:scale-[0.98] disabled:cursor-not-allowed disabled:hover:translate-y-0 ${FOCUS} ${sizes[size]} ${variants[variant]} ${className}`}
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
  leading,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string;
  hint?: string;
  /** An optional adornment (icon) rendered inside the input's leading edge. */
  leading?: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-[var(--color-fg)]">{label}</span>
      <span className="relative block">
        {leading && (
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[var(--color-fg-subtle)]">
            {leading}
          </span>
        )}
        <input
          {...props}
          // Errors are announced, not just coloured — a red border is invisible to a screen reader
          // and to a colour-blind user (Doc 08 accessibility).
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${props.name ?? label}-error` : undefined}
          className={`w-full rounded-lg border bg-[var(--color-bg-elevated)] py-2.5 text-sm shadow-[var(--shadow-xs)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] ease-[var(--ease-standard)] outline-none placeholder:text-[var(--color-fg-subtle)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand-500)]/30 focus-visible:ring-offset-0 ${
            leading ? "pr-3.5 pl-9" : "px-3.5"
          } ${
            error
              ? "border-[var(--color-danger)] focus-visible:border-[var(--color-danger)]"
              : "border-[var(--color-border-strong)] focus-visible:border-[var(--color-brand-500)]"
          } ${className}`}
        />
      </span>
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

/** A tiny inline glyph set so the primitives can carry an icon without a dependency. */
const ALERT_ICON: Record<string, ReactNode> = {
  danger: <IconAlertTriangle />,
  warning: <IconAlertTriangle />,
  success: <IconCheckCircle />,
  info: <IconInfo />,
};

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
    /**
     * `--color-info`, not `bg-subtle` + `fg-muted`. The token ramp has carried an info blue
     * (re-picked for dark) all along; painting this one tone in the PAGE background and muted grey
     * made every informational message look disabled. Three tones spoke semantic colour and the
     * fourth mumbled.
     */
    info: "bg-[var(--color-info-bg)] text-[var(--color-info)] border-[var(--color-info)]/20",
  };

  /**
   * `role="alert"` is ASSERTIVE: it interrupts a screen reader mid-sentence. Right for "your
   * password is wrong", rude for "your session ended". Reserving interruption for the tones that
   * demand action is what keeps the interruption meaningful.
   */
  const urgent = tone === "danger" || tone === "warning";

  return (
    <div
      role={urgent ? "alert" : "status"}
      className={`mc-fade-in flex gap-3 rounded-xl border px-4 py-3 text-sm ${tones[tone]}`}
    >
      <span className="mt-0.5 shrink-0" aria-hidden>
        {ALERT_ICON[tone]}
      </span>
      <div className="min-w-0">
        {title && <p className="mb-0.5 font-semibold">{title}</p>}
        {children}
      </div>
    </div>
  );
}

/**
 * A danger Alert for a caught error that also shows its REFERENCE — the `code · traceId` that maps
 * to the server log for that request. Accepts any thrown value; pass a `fallback` for the non-API
 * case. This is how a failure the user sees becomes a failure we can find.
 */
export function ErrorAlert({
  error,
  fallback,
  title,
}: {
  error: unknown;
  fallback?: string;
  title?: string;
}) {
  const { message, reference } = describeError(error, fallback);
  return (
    <Alert tone="danger" {...(title ? { title } : {})}>
      <span>{message}</span>
      {reference && (
        <span className="mt-1 block font-mono text-[11px] break-all opacity-70 select-all">
          Ref: {reference}
        </span>
      )}
    </Alert>
  );
}

export function Card({
  children,
  className = "",
  interactive = false,
  gradient = false,
}: {
  children: ReactNode;
  className?: string;
  /** Lifts on hover — for a whole card that is itself a link/button. */
  interactive?: boolean;
  /** A whisper-quiet brand wash from the top, to lift the card off the page. */
  gradient?: boolean;
}) {
  return (
    <div
      style={gradient ? { background: "var(--gradient-surface)" } : undefined}
      className={`rounded-xl border border-[var(--color-border)] shadow-[var(--shadow-xs)] ${
        gradient ? "" : "bg-[var(--color-bg-elevated)]"
      } ${
        interactive
          ? "cursor-pointer transition-[transform,box-shadow,border-color] duration-[var(--dur)] ease-[var(--ease-standard)] hover:-translate-y-0.5 hover:border-[var(--color-border-strong)] hover:shadow-[var(--shadow-md)]"
          : ""
      } ${className}`}
    >
      {children}
    </div>
  );
}

export function Badge({
  children,
  tone = "neutral",
  dot = false,
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger" | "brand" | "info";
  /** A leading status dot in the tone's colour. */
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

/* ────────────────────────────────────────────────────────────────────────────
 * New primitives — the loading / empty / metric vocabulary the app was missing.
 * ──────────────────────────────────────────────────────────────────────────── */

/** A shimmering placeholder for content that has not loaded. Respects reduced-motion. */
export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`relative block overflow-hidden rounded-md bg-[var(--color-bg-subtle)] ${className}`}
    >
      <span className="absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent via-[var(--color-border)]/60 to-transparent [animation:mc-shimmer_1.4s_infinite]" />
    </span>
  );
}

/** A spinner sized to context. */
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`inline-block animate-spin rounded-full border-2 border-current border-t-transparent opacity-60 ${className}`}
    />
  );
}

/** A considered empty state — an icon, a line, and (optionally) the way out of it. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mc-fade-in flex flex-col items-center justify-center px-6 py-14 text-center">
      {icon && (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--color-bg-subtle)] text-[var(--color-fg-subtle)]">
          {icon}
        </div>
      )}
      <p className="text-sm font-medium text-[var(--color-fg)]">{title}</p>
      {description && (
        <p className="mt-1 max-w-sm text-sm text-[var(--color-fg-muted)]">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** A metric tile — the dashboard's atom. Icon, value, label, optional trend. */
export function StatCard({
  label,
  value,
  icon,
  trend,
  tone = "brand",
}: {
  label: string;
  value: ReactNode;
  icon?: ReactNode;
  trend?: { direction: "up" | "down" | "flat"; label: string };
  tone?: "brand" | "success" | "warning" | "danger" | "info";
}) {
  const iconTone: Record<string, string> = {
    brand: "bg-[var(--color-brand-50)] text-[var(--color-brand-700)]",
    success: "bg-[var(--color-success-bg)] text-[var(--color-success)]",
    warning: "bg-[var(--color-warning-bg)] text-[var(--color-warning)]",
    danger: "bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
    info: "bg-[var(--color-info-bg)] text-[var(--color-info)]",
  };
  const trendTone =
    trend?.direction === "up"
      ? "text-[var(--color-success)]"
      : trend?.direction === "down"
        ? "text-[var(--color-danger)]"
        : "text-[var(--color-fg-muted)]";
  const trendGlyph = trend?.direction === "up" ? "↑" : trend?.direction === "down" ? "↓" : "→";

  return (
    <Card gradient className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-[var(--color-fg-muted)]">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-[var(--color-fg)] tabular-nums">
            {value}
          </p>
        </div>
        {icon && (
          <div
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${iconTone[tone]}`}
          >
            {icon}
          </div>
        )}
      </div>
      {trend && (
        <p className={`mt-3 text-xs font-medium ${trendTone}`}>
          <span aria-hidden>{trendGlyph}</span> {trend.label}
        </p>
      )}
    </Card>
  );
}

/** A simple, accessible tab strip. Controlled by the caller. */
export function Tabs({
  tabs,
  active,
  onChange,
}: {
  tabs: { key: string; label: ReactNode; count?: number }[];
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div role="tablist" className="flex gap-1 border-b border-[var(--color-border)]">
      {tabs.map((tab) => {
        const on = tab.key === active;
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.key)}
            className={`relative -mb-px flex items-center gap-2 border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors duration-[var(--dur-fast)] ${FOCUS} ${
              on
                ? "border-[var(--color-brand-600)] text-[var(--color-fg)]"
                : "border-transparent text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
            }`}
          >
            {tab.label}
            {tab.count != null && (
              <span
                className={`rounded-full px-1.5 py-0.5 text-[11px] tabular-nums ${
                  on
                    ? "bg-[var(--color-brand-50)] text-[var(--color-brand-700)]"
                    : "bg-[var(--color-bg-subtle)] text-[var(--color-fg-muted)]"
                }`}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A centered modal. ONE implementation, replacing the copy each list page used to hand-roll — same
 * scrim, focus, Escape-to-close and entrance everywhere. Close with the ✕, the scrim, or Escape.
 */
export function Modal({
  title,
  onClose,
  children,
  width = "max-w-lg",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // The scrim covers the page; stop the body scrolling behind it.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  // Rendered through a PORTAL to <body> so it escapes every ancestor stacking context — otherwise a
  // modal nested inside <main> can be trapped BELOW the sticky top bar and its close button becomes
  // unreachable. On body, its z-50 always wins.
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
            className="rounded-lg p-1.5 text-[var(--color-fg-subtle)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-fg)]"
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

/**
 * A premium data table — ONE place that owns table spacing, the sticky header, hover rows and the
 * loading / empty states, so every list in the app breathes the same way. Presentational: give it
 * columns and rows; pass `onRowClick` to make rows navigable.
 */
export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: "left" | "right" | "center";
  /** Extra classes for this column's cells (e.g. `font-mono`, `whitespace-nowrap`). */
  cellClassName?: string;
  headerClassName?: string;
}

export function DataTable<T>({
  columns,
  rows,
  keyOf,
  loading = false,
  empty,
  onRowClick,
  rowClassName,
}: {
  columns: Column<T>[];
  rows: T[];
  keyOf: (row: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
}) {
  const alignOf = (a?: "left" | "right" | "center") =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

  return (
    <div className="overflow-x-auto rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-xs)]">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-[var(--color-border)] text-xs tracking-wide text-[var(--color-fg-subtle)] uppercase">
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={`px-5 py-3.5 font-medium ${alignOf(c.align)} ${c.headerClassName ?? ""}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border)]">
          {loading ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-5 py-12 text-center text-[var(--color-fg-subtle)]"
              >
                Loading…
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-5 py-12 text-center text-[var(--color-fg-muted)]"
              >
                {empty ?? "Nothing here yet."}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={keyOf(row)}
                {...(onRowClick ? { onClick: () => onRowClick(row) } : {})}
                className={`${onRowClick ? "cursor-pointer" : ""} transition-colors hover:bg-[var(--color-bg-subtle)] ${
                  rowClassName?.(row) ?? ""
                }`}
              >
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={`px-5 py-4 ${alignOf(c.align)} ${c.cellClassName ?? ""}`}
                  >
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The confirmation, in the application.
 *
 * ── WHY NOT `window.confirm` / `window.prompt` ──────────────────────────────
 * They are not a style problem. A native dialog cannot be labelled for a screen reader, cannot
 * show the patient it is about, cannot validate what is typed, and — the part that actually bites
 * — CAN BE SUPPRESSED. Chrome offers "prevent this page from creating additional dialogues" after
 * the second one, and every browser suppresses them outright inside a cross-origin frame. A
 * technician who ticks that box silently loses the ability to cancel an order or record a note:
 * `prompt` returns `null`, our code reads that as "cancelled", and the button does nothing forever
 * with no error to report. `MedicationRecord` already learned this at the bedside; this is the
 * same lesson, made shared.
 *
 * ── WHAT IT REPLACES, IN BOTH SHAPES ────────────────────────────────────────
 * `confirm` — omit `reason`. `prompt` — pass `reason` and receive the text in `onConfirm`. A
 * required reason is enforced BEFORE the request, so a server-side minimum length never comes
 * back as a validation error the user cannot connect to anything they did.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  tone = "default",
  busy = false,
  reason,
  onConfirm,
  onCancel,
}: {
  title: ReactNode;
  /** The consequence, in the user's terms. Shown above the reason box. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` for anything that destroys, revokes or cannot be undone. */
  tone?: "default" | "danger";
  busy?: boolean;
  /** Present ⇒ this is a `prompt`. The text is handed to `onConfirm`. */
  reason?: {
    label: string;
    placeholder?: string;
    /** Blank ⇒ optional. Set to the server's own minimum so the two never disagree. */
    minLength?: number;
    defaultValue?: string;
    multiline?: boolean;
    /**
     * Anything beyond a length check — returns the problem, or `null` when the text is fine.
     * The amount dialogs use it: `toPaise` turns an unparseable figure into ZERO, so without a
     * check here a fat-fingered "12o0" approves a claim for nothing at all, silently.
     */
    validate?: (text: string) => string | null;
  };
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(reason?.defaultValue ?? "");
  const trimmed = text.trim();
  const min = reason?.minLength ?? 0;
  const short = min > 0 && trimmed.length < min;
  const invalid = !short && reason?.validate ? reason.validate(trimmed) : null;

  const field = reason ? (
    <label className="block text-sm font-medium text-[var(--color-fg)]">
      {reason.label}
      {min > 0 && <span className="ml-1 text-[var(--color-danger)]">*</span>}
      {reason.multiline === false ? (
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={reason.placeholder ?? ""}
          autoFocus
          className="mt-1.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm font-normal text-[var(--color-fg)]"
        />
      ) : (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={reason.placeholder ?? ""}
          rows={2}
          autoFocus
          className="mt-1.5 w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm font-normal text-[var(--color-fg)]"
        />
      )}
      {short && (
        <span className="mt-1 block text-xs font-normal text-[var(--color-fg-subtle)]">
          At least {min} characters — it is stored on the record and read by whoever picks this up
          next.
        </span>
      )}
      {invalid !== null && (
        <span className="mt-1 block text-xs font-normal text-[var(--color-danger)]">{invalid}</span>
      )}
    </label>
  ) : null;

  return (
    /**
     * While the write is IN FLIGHT the dialog cannot be dismissed — not by ✕, not by the scrim, not
     * by Escape. Closing it mid-request would leave the user with no idea whether the thing
     * happened, which is the exact ambiguity that had a technician upload the same report twice.
     */
    <Modal title={title} onClose={busy ? () => undefined : onCancel}>
      <div className="space-y-4">
        {children && <div className="text-sm text-[var(--color-fg-muted)]">{children}</div>}
        {field}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            loading={busy}
            disabled={busy || short || invalid !== null}
            onClick={() => onConfirm(trimmed)}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Hides UI the user cannot use. Convenience ONLY — the server independently refuses the action
 * (Constitution §3.6). Never rely on this to protect anything.
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

/* ── inline icons (no dependency; currentColor) ──────────────────────────────── */

function IconAlertTriangle() {
  return (
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
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function IconCheckCircle() {
  return (
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
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  );
}
function IconInfo() {
  return (
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
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}
