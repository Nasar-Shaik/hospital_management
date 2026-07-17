/**
 * Integration-test harness against a REAL mail server (Mailhog).
 *
 * ── WHY A REAL SMTP SERVER AND NOT A MOCK ───────────────────────────────────
 * A mocked transport proves that we CALLED nodemailer. That is not the claim worth
 * defending. The claim worth defending is that a patient who books an appointment
 * receives an email — and every interesting way that fails (the transport is never
 * built because SMTP_HOST is unset, the address is malformed, the body renders with
 * an empty `{{doctor}}`, the message is sent twice) is invisible to a mock that
 * happily records whatever it is handed.
 *
 * So the suite talks to Mailhog, reads its inbox over HTTP, and asserts on what
 * ACTUALLY ARRIVED. It fails rather than skips when Mailhog is absent, for the same
 * reason the Redis harness does: a "passing" notification suite with no mail server
 * would assert nothing at all, and would be worse than no suite — it would be a
 * green tick that means nothing.
 */
const MAILHOG_API = process.env.MAILHOG_API_URL ?? "http://127.0.0.1:8025";

export const TEST_SMTP_HOST = process.env.TEST_SMTP_HOST ?? "127.0.0.1";
export const TEST_SMTP_PORT = process.env.TEST_SMTP_PORT ?? "1025";

export interface CapturedMail {
  to: string[];
  subject: string;
  body: string;
}

export async function assertMailhogReachable(): Promise<void> {
  try {
    const res = await fetch(`${MAILHOG_API}/api/v2/messages?limit=1`);
    if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
  } catch (err) {
    throw new Error(
      `Integration tests require Mailhog at ${MAILHOG_API}.\n` +
        `Start it with: pnpm docker:dev  (SMTP 1025, UI 8025)\n` +
        `Underlying error: ${String(err)}`,
    );
  }
}

/**
 * Empties the inbox, so one test cannot read another's mail.
 *
 * ── THIS DELETES EVERYTHING, FOR EVERY SUITE ────────────────────────────────
 * There is ONE Mailhog, and it has no notion of an inbox per test file. So this is a
 * destructive operation on a shared resource: two suites that both send mail and both
 * clear it will delete each other's messages, and the symptom is not an error — it is
 * an assertion that mysteriously finds nothing, in whichever suite happened to lose
 * the race.
 *
 * That is exactly what happened when Orders became the second suite to use the mail
 * server (it had been the sole preserve of the notifications suite), and it is why
 * `test:int` now runs with `--no-file-parallelism`.
 *
 * Integration suites share ONE Mongo, ONE Redis and ONE SMTP server. They are isolated
 * in Mongo and Redis by naming — a database and a key prefix per suite — but mail has
 * no such handle to hang isolation on. Serial execution is what keeps them honest.
 */
export async function clearMailbox(): Promise<void> {
  await fetch(`${MAILHOG_API}/api/v1/messages`, { method: "DELETE" });
}

interface MailhogMessage {
  Content: { Headers: Record<string, string[]>; Body: string };
  Raw: { To: string[] };
}

/**
 * Everything currently in the inbox, newest first.
 *
 * Mailhog encodes long lines with quoted-printable, so a subject or body that
 * wraps arrives with `=\r\n` seams and `=XX` escapes in it. Decoding them here means
 * an assertion can read like a human ("the mail names the doctor") instead of
 * asserting on transport encoding — which would pass for the wrong reason the day
 * a name gets long enough to wrap.
 */
export async function inbox(): Promise<CapturedMail[]> {
  const res = await fetch(`${MAILHOG_API}/api/v2/messages?limit=100`);
  const json = (await res.json()) as { items: MailhogMessage[] };

  return json.items.map((item) => ({
    to: item.Raw.To,
    subject: decodeHeader(item.Content.Headers.Subject?.[0] ?? ""),
    body: decodeQuotedPrintable(item.Content.Body),
  }));
}

/**
 * Decodes an RFC 2047 "encoded word" header: `=?UTF-8?Q?Appointment_confirmed?=`.
 *
 * A subject containing an em-dash — which ours do — is not ASCII, so nodemailer
 * encodes the whole header. This is CORRECT behaviour, and a mail client shows the
 * human the right thing. It caught the suite out first time round, and the lesson is
 * worth keeping: an assertion that reads raw transport encoding tests the encoder,
 * not the product.
 */
function decodeHeader(text: string): string {
  return text.replace(
    /=\?[^?]+\?([QqBb])\?([^?]*)\?=/g,
    (_match, encoding: string, payload: string) => {
      if (encoding.toUpperCase() === "B") {
        return Buffer.from(payload, "base64").toString("utf8");
      }
      // Q-encoding: like quoted-printable, but `_` also means a space.
      return decodeQuotedPrintable(payload.replace(/_/g, " "));
    },
  );
}

function decodeQuotedPrintable(text: string): string {
  const withoutSoftBreaks = text.replace(/=\r?\n/g, "");

  // Decode as BYTES, then interpret as UTF-8. Doing it character-by-character
  // mangles anything multi-byte — every accented name, and the em-dash in our own
  // subject lines.
  const bytes: number[] = [];
  for (let i = 0; i < withoutSoftBreaks.length; i++) {
    const char = withoutSoftBreaks[i] ?? "";
    const hex = withoutSoftBreaks.slice(i + 1, i + 3);

    if (char === "=" && /^[0-9A-F]{2}$/i.test(hex)) {
      bytes.push(Number.parseInt(hex, 16));
      i += 2;
    } else {
      bytes.push(...Buffer.from(char, "utf8"));
    }
  }

  return Buffer.from(bytes).toString("utf8");
}

/**
 * Mail is delivered asynchronously — the HTTP response that booked the appointment
 * returns long before the consumer has run. Polls until `count` messages arrive.
 *
 * Deliberately returns what it found rather than throwing on timeout: a test
 * asserting "no reminder was sent for a cancelled appointment" needs to wait the
 * full window and then find NOTHING, and a helper that threw would make that
 * assertion impossible to write.
 */
export async function waitForMail(count: number, timeoutMs = 5_000): Promise<CapturedMail[]> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const messages = await inbox();
    if (messages.length >= count) return messages;
    if (Date.now() > deadline) return messages;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
