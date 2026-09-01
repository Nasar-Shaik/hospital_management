"use client";

/**
 * Alerts — everything the hospital has sent this person.
 *
 * ── WHY THERE IS A PAGE AND NOT JUST THE BELL ───────────────────────────────
 * The bell shows five unread. A doctor coming back from leave, or looking for the result they
 * half-remember being told about on Tuesday, needs the rest — and a message that can only be seen
 * once, in a dropdown, before it is dismissed is not a record of anything.
 *
 * Opening a message here does NOT navigate anywhere. The ledger row carries no patient id (see
 * `notification.model.ts` — it stores the rendered text, not the ids that produced it), so a link
 * would have to be guessed from the body, and a link that takes a clinician to the wrong patient
 * is worse than no link. The message names the patient and their UHID; the chart is one search
 * away. Deep links are a follow-up that starts with the callers passing ids to `notify()`.
 */
import { useCallback, useEffect, useState } from "react";
import { ApiClientError, type InboxMessage } from "@medicore/api-client";
import { useAuth } from "../../components/AuthProvider";
import { Alert, Badge, Button, Card } from "../../components/ui";
import { isUnread, titleFor, toneFor } from "../../lib/alerts";

const PAGE = 20;

function when(iso: string): string {
  return new Date(iso).toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Alerts() {
  const { api } = useAuth();
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.myNotifications({
        page,
        limit: PAGE,
        ...(unreadOnly ? { unread: true } : {}),
      });
      // The server's order is kept here, unlike the bell's: this is a list somebody is reading,
      // and a chronological one is what "when was I told?" is answered from.
      setMessages(result.items);
      setTotal(result.meta.total ?? result.items.length);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not load your alerts.");
    } finally {
      setLoading(false);
    }
  }, [api, page, unreadOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(message: InboxMessage) {
    if (!isUnread(message)) return;
    try {
      const opened = await api.markNotificationRead(message.id);
      setMessages((current) => current.map((m) => (m.id === opened.id ? opened : m)));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not mark that as read.");
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[var(--color-fg)]">Alerts</h1>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Everything the hospital has sent you — results you ordered, and anything that needed your
          attention. Messages from every site you work at appear here.
        </p>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex items-center gap-2">
        <Button
          variant={unreadOnly ? "primary" : "secondary"}
          onClick={() => {
            setUnreadOnly((u) => !u);
            setPage(1);
          }}
        >
          {unreadOnly ? "Showing unread" : "Show unread only"}
        </Button>
        <span className="text-sm text-[var(--color-fg-muted)]">
          {loading ? "Loading…" : `${String(total)} ${unreadOnly ? "unread" : "in total"}`}
        </span>
      </div>

      <Card>
        <ul className="divide-y divide-[var(--color-border)]">
          {!loading && messages.length === 0 && (
            <li className="p-8 text-center text-sm text-[var(--color-fg-muted)]">
              {unreadOnly ? "Nothing unread." : "You have not been sent anything yet."}
            </li>
          )}

          {messages.map((message) => {
            const critical = toneFor(message.templateKey) === "critical";
            return (
              <li key={message.id}>
                <button
                  type="button"
                  onClick={() => void open(message)}
                  className={`w-full px-4 py-3.5 text-left transition-colors hover:bg-[var(--color-bg-subtle)] ${
                    isUnread(message) ? "bg-[var(--color-bg-subtle)]/40" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={
                        critical
                          ? "font-semibold text-[var(--color-danger)]"
                          : "font-medium text-[var(--color-fg)]"
                      }
                    >
                      {titleFor(message)}
                    </span>
                    {critical && <Badge tone="danger">Critical</Badge>}
                    {isUnread(message) && <Badge tone="brand">Unread</Badge>}
                    <span className="ml-auto text-xs text-[var(--color-fg-subtle)]">
                      {when(message.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap text-sm text-[var(--color-fg-muted)]">
                    {message.body}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>

      {total > PAGE && (
        <div className="flex items-center justify-between">
          <Button
            variant="secondary"
            disabled={page === 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <span className="text-sm text-[var(--color-fg-muted)]">
            Page {page} of {Math.max(1, Math.ceil(total / PAGE))}
          </span>
          <Button
            variant="secondary"
            disabled={page * PAGE >= total || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}

export default function Page() {
  return <Alerts />;
}
