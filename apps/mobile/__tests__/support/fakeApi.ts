/**
 * A fake TRANSPORT — not a fake architecture.
 *
 * ── WHAT IS REAL IN THESE TESTS ─────────────────────────────────────────────
 * The shipped `@medicore/api-client`, the real `createRuntime` wiring, the real stores, the real
 * session and branch controllers. What is substituted is exactly the two edges a phone owns and a
 * CI box does not: the network and the Keychain.
 *
 * That boundary is chosen deliberately. Mocking `ApiClient` would prove that the app calls methods
 * that exist; mocking `fetch` proves that the app and the client together produce the right
 * REQUESTS and survive the real RESPONSES — including the envelope parsing, the `onUnauthorized`
 * replay and the error typing, which is where the interesting defects live.
 *
 * The envelope shapes below are the API's actual contract (`{ success, data }` /
 * `{ success, error: { code, message, details, traceId } }`), so a change to them breaks these
 * tests, which is the intended coupling.
 */

export interface RecordedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}

export type Responder = (call: RecordedCall) => Response | Promise<Response>;

export interface FakeApi {
  fetchImpl: typeof fetch;
  /** Every request the client made, in order. The assertion surface for headers. */
  calls: RecordedCall[];
  /** Program a route. Later registrations for the same route replace earlier ones. */
  on(method: string, path: string, responder: Responder): void;
  /** Program a route to answer once, then fall back to whatever `on` has registered. */
  once(method: string, path: string, responder: Responder): void;
  /** Make the transport itself fail — a dropped connection, not an API error. */
  goOffline(): void;
  goOnline(): void;
  callsTo(method: string, path: string): RecordedCall[];
}

export function ok(data: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export function created(data: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 201,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

export function fail(
  status: number,
  code: string,
  message = "failed",
  details?: unknown,
  traceId = "trace-test",
): Response {
  return new Response(
    JSON.stringify({ success: false, error: { code, message, details, traceId } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

export function createFakeApi(): FakeApi {
  const routes = new Map<string, Responder>();
  const onceRoutes = new Map<string, Responder[]>();
  const calls: RecordedCall[] = [];
  let offline = false;

  const key = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

  const fetchImpl = (async (
    input: RequestInfo | URL,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v,
      ]),
    );
    const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    const call: RecordedCall = {
      method,
      path: url.pathname,
      headers,
      ...(body !== undefined ? { body } : {}),
    };
    calls.push(call);

    if (offline) {
      // What React Native's fetch actually throws when there is no route to the host. The client
      // does not catch it, so it surfaces as a non-ApiClientError — which is precisely how
      // `isNetworkFailure` distinguishes the wire from the API.
      throw new TypeError("Network request failed");
    }

    const routeKey = key(method, url.pathname);
    const queued = onceRoutes.get(routeKey);
    if (queued && queued.length > 0) {
      const responder = queued.shift();
      if (responder) return responder(call);
    }

    const responder = routes.get(routeKey);
    if (!responder) {
      return fail(404, "HMS-GEN-404", `no fake route for ${routeKey}`);
    }
    return responder(call);
  }) as typeof fetch;

  return {
    fetchImpl,
    calls,
    on: (method, path, responder) => routes.set(key(method, path), responder),
    once: (method, path, responder) => {
      const routeKey = key(method, path);
      onceRoutes.set(routeKey, [...(onceRoutes.get(routeKey) ?? []), responder]);
    },
    goOffline: () => {
      offline = true;
    },
    goOnline: () => {
      offline = false;
    },
    callsTo: (method, path) =>
      calls.filter((c) => c.method === method.toUpperCase() && c.path === path),
  };
}
