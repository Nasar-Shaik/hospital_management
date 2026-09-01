/**
 * One listening server per suite, on the loopback address.
 *
 * ── THE OUTAGE THIS PREVENTS ─────────────────────────────────────────────────
 * `request(app)` is not one server. supertest wraps the Express app in a fresh
 * `http.createServer(app)` and calls `app.listen(0)` FOR EVERY REQUEST, then builds
 * the URL as `http://127.0.0.1:<port>`. A full integration run makes ~4,100
 * requests, so it burns ~8,200 ephemeral ports — and the ephemeral range on macOS
 * is 16,384 wide (49152–65535). One run sweeps most of the range.
 *
 * `listen(0)` with no host binds the WILDCARD address, and Node sets SO_REUSEADDR on
 * listening sockets. On BSD/macOS that means the wildcard bind SUCCEEDS on a port
 * another process already holds on a specific address — no EADDRINUSE, no warning.
 * The connection is then made to `127.0.0.1:<port>`, and the kernel routes it to the
 * MOST SPECIFIC listener: the other process.
 *
 * Which is not hypothetical. On the machine this was found on, the editor's helper
 * processes and a JVM held five loopback listeners inside the ephemeral range:
 *
 *   Code Helper  738   127.0.0.1:49183      Code Helper 2007  127.0.0.1:53579
 *   Code Helper  1559  127.0.0.1:49435      java        2393  127.0.0.1:49671
 *   Code Helper  1991  127.0.0.1:49715
 *
 * Sweep the range and you land on one. The request goes to the editor, and the
 * editor ANSWERS — plausibly, because some of those servers are themselves Express,
 * so what comes back is a real Express 404 (`x-powered-by: Express`) for a route it
 * has never heard of. The JVM accepted the connection and reset it: "socket hang up".
 *
 * The symptom was one suite failing per run, never the same suite twice, always with
 * an answer this application would never give — a 404 where the RBAC matrix demands
 * 403, a 401 in a suite that had authenticated fine a line earlier. It was mistaken
 * in turn for a Mailhog race, container contention and a Mongo memory leak. The tell
 * that broke it open was that our request log had NO LINE for the failing request,
 * which was not a logging bug: the request never arrived here.
 *
 * ── WHY THIS SHAPE ───────────────────────────────────────────────────────────
 * Binding 127.0.0.1 is the fix — the kernel will not hand a `127.0.0.1:0` bind a port
 * already in LISTEN on 127.0.0.1, so the collision goes from rare to impossible. But
 * a bind WITH a host is asynchronous (Node resolves it through `dns.lookup`, which
 * defers even for a literal IP), and supertest reads `.address()` synchronously on
 * the line after it listens. So the listen cannot stay in the per-request path: it is
 * hoisted here, awaited once per suite, and supertest — handed a server that is
 * already listening — reuses it instead of opening another.
 *
 * That the wildcard is what does the damage, and that the loopback bind refuses
 * loudly instead, are both pinned in src/testServerBinding.test.ts.
 */
import http from "node:http";
import type { Express } from "express";

/** The app, listening on 127.0.0.1 and off the event loop's books. Pass it to `request()`. */
export function listening(app: Express): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      // Nothing should wait on this to close for the process to exit.
      server.unref();
      resolve(server);
    });
  });
}
