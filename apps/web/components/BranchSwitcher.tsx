"use client";

/**
 * The branch switcher (ADR-0015) — the header control that shows the active site and changes it.
 *
 * Renders nothing when there is no choice to make (a single-branch hospital, or a user bound to one
 * site): the whole multi-branch machinery stays invisible to the customers who do not use it. When
 * there IS a choice, it lists the user's branches and — if they may aggregate — an "All branches"
 * option that puts reports into cross-branch mode.
 *
 * ── THE SWITCH IS ANNOUNCED, NOT JUST DRAWN ─────────────────────────────────
 * Choosing a branch discards every screen below and reloads it (`BranchScope`). A sighted user
 * sees the spinners; a screen-reader user would get a silently changed button label and a page
 * that quietly became something else. The live region says which site is now in force and that its
 * data is loading — the same two facts, through the other channel.
 */
import { useEffect, useRef, useState } from "react";
import { useBranch } from "./BranchProvider";

export function BranchSwitcher() {
  const { branches, active, canAggregate, hasChoice, select } = useBranch();
  const [open, setOpen] = useState(false);
  const [switched, setSwitched] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  /** Turns a selection into both the scope change and the announcement. */
  const choose = (branchId: string | null) => {
    setSwitched(true);
    select(branchId);
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // Nothing to switch — don't clutter the header.
  if (!hasChoice) return null;

  const label = active ? active.name : canAggregate ? "All branches" : "Select branch";

  return (
    <div className="relative" ref={ref}>
      {/* Announced only after a deliberate switch — never on first load, which would read the
          branch name at every sign-in for no reason. */}
      <span className="sr-only" role="status" aria-live="polite">
        {switched ? `Now working in ${label}. Loading this branch's data.` : ""}
      </span>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-2 rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-1.5 text-sm hover:bg-[var(--color-bg-subtle)]"
        title="Switch branch"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="text-[var(--color-fg-muted)]"
        >
          <path d="M3 21h18" />
          <path d="M5 21V7l7-4 7 4v14" />
          <path d="M9 21v-6h6v6" />
          <path d="M9 9h.01M15 9h.01" />
        </svg>
        <span className="max-w-[140px] truncate font-medium text-[var(--color-fg)]">{label}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="text-[var(--color-fg-subtle)]"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-2 w-60 rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] p-1.5 shadow-lg">
          <p className="px-2.5 py-1.5 text-[11px] font-semibold tracking-wide text-[var(--color-fg-subtle)] uppercase">
            Working in
          </p>

          {canAggregate && (
            <BranchOption
              label="All branches"
              hint="Reports aggregate across sites"
              selected={!active}
              onClick={() => choose(null)}
            />
          )}

          {branches.map((b) => (
            <BranchOption
              key={b.id}
              label={b.name}
              hint={b.code}
              selected={active?.id === b.id}
              onClick={() => choose(b.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BranchOption({
  label,
  hint,
  selected,
  onClick,
}: {
  label: string;
  hint: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-[var(--color-bg-subtle)] ${
        selected ? "bg-[var(--color-bg-subtle)]" : ""
      }`}
    >
      <span className="min-w-0">
        <span className="block truncate font-medium text-[var(--color-fg)]">{label}</span>
        <span className="block truncate text-xs text-[var(--color-fg-muted)]">{hint}</span>
      </span>
      {selected && (
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
          className="shrink-0 text-[var(--color-brand-600)]"
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
    </button>
  );
}
