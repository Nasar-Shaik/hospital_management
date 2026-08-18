"use client";

/**
 * The bell — what came in while you were working.
 *
 * ── ONE REQUEST, NOT TWO ────────────────────────────────────────────────────
 * `?unread=true&limit=5` answers both halves at once: under that filter the page meta's `total`
 * IS the unread count, and the five rows are the preview. A separate count endpoint would have
 * been a second route and a second round trip to render one badge.
 *
 * ── IT POLLS, AND THAT IS A DELIBERATE FLOOR ────────────────────────────────
 * Sixty seconds. ADR-0008 accepts Socket.IO as the push transport and `channels/inapp.ts` names
 * this as the place it will hook in — at which point the poll becomes a fallback rather than the
 * mechanism. Until then a minute is the honest promise: fast enough that a released result is
 * noticed within a consultation, slow enough that a hospital of 200 staff is not sending 200
 * requests a second at its own API.
 *
 * A critical result does NOT rely on this. It is raised inline, before the API call that recorded
 * it returns, and the doctor who ordered it also sees it on the chart — the bell is the surface
 * that stops someone having to go looking.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ApiClientError, type InboxMessage } from "@medicore/api-client";
import { useAuth } from "./AuthProvider";
import { badgeCount, isUnread, sortForBell, titleFor, toneFor } from "../lib/alerts";
import { Icon } from "./icons";

const POLL_MS = 60_000;
const PREVIEW = 5;

function when(iso: string): string {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function AlertBell() {
  const { api } = useAuth();
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  /**
   * A failed poll is silent on purpose. The bell is ambient: an error banner over the whole
   * application because one background refresh missed would be far more disruptive than the
   * missing count, and the next tick fixes it. A failure that matters — the session ending — is
   * already handled by the client, everywhere at once.
   */
  const failed = useRef(false);

  const load = useCallback(async () => {
    try {
      const page = await api.myNotifications({ unread: true, limit: PREVIEW });
      setMessages(sortForBell(page.items));
      setUnread(page.meta.total ?? page.items.length);
      failed.current = false;
    } catch (err) {
      failed.current = !(err instanceof ApiClientError && err.status === 401);
    }
  }, [api]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [load]);

  async function openMessage(id: string) {
    // Optimistic: the row leaves the unread list immediately, because the user has just read it
    // and a badge that lags by a network round trip feels broken. The server is the truth, and
    // the next poll reconciles if the write failed.
    setMessages((current) => current.filter((m) => m.id !== id));
    setUnread((n) => Math.max(0, n - 1));
    try {
      await api.markNotificationRead(id);
    } catch {
      void load();
    }
  }

  const badge = badgeCount(unread);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-[var(--color-fg-muted)] transition-colors hover:bg-[var(--color-bg-subtle)] hover:text-[var(--color-fg)]"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={badge ? `Alerts — ${badge} unread` : "Alerts"}
      >
        <Icon name="bell" className="h-5 w-5" />
        {badge && (
          <span className="absolute -right-0.5 -top-0.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-[var(--color-danger)] px-1 text-[0.625rem] font-semibold leading-4 text-white">
            {badge}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} aria-hidden />
          <div className="mc-scale-in absolute right-0 z-20 mt-2 w-80 origin-top-right rounded-xl border border-[var(--color-border)] bg-[var(--color-bg-elevated)] shadow-[var(--shadow-lg)] sm:w-96">
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
              <p className="text-sm font-medium text-[var(--color-fg)]">Alerts</p>
              <Link
                href="/alerts"
                onClick={() => setOpen(false)}
                className="text-xs text-[var(--color-brand-700)] hover:underline"
              >
                See all
              </Link>
            </div>

            <ul className="max-h-96 divide-y divide-[var(--color-border)] overflow-y-auto">
              {messages.length === 0 && (
                <li className="px-4 py-6 text-center text-sm text-[var(--color-fg-muted)]">
                  {failed.current ? "Could not reach the server." : "Nothing new."}
                </li>
              )}

              {messages.map((message) => (
                <li key={message.id}>
                  <button
                    type="button"
                    onClick={() => void openMessage(message.id)}
                    className="w-full px-4 py-3 text-left transition-colors hover:bg-[var(--color-bg-subtle)]"
                  >
                    <div className="flex items-start gap-2">
                      {toneFor(message.templateKey) === "critical" && (
                        <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--color-danger)]" />
                      )}
                      <div className="min-w-0">
                        <p
                          className={`truncate text-sm ${
                            toneFor(message.templateKey) === "critical"
                              ? "font-semibold text-[var(--color-danger)]"
                              : "font-medium text-[var(--color-fg)]"
                          }`}
                        >
                          {titleFor(message)}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-xs text-[var(--color-fg-muted)]">
                          {message.body}
                        </p>
                        <p className="mt-1 text-xs text-[var(--color-fg-subtle)]">
                          {when(message.createdAt)}
                        </p>
                      </div>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

/** Re-exported so the inbox page and the bell agree on what "unread" looks like. */
export { isUnread };
