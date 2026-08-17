/**
 * The harness's own guard rail — see src/test/appServer.ts for the outage behind it.
 *
 * A test server that binds the wildcard address can be silently handed a port another
 * process on this machine already holds on 127.0.0.1; because supertest connects to
 * 127.0.0.1, the request then goes to THAT process, which answers with something this
 * application would never say. It cost days to find, because the evidence for it is an
 * absence: no line in our request log, since the request never reached us.
 *
 * Pinned here: that the guard is on, that it is load-bearing, and that the supported
 * way of getting a server produces one request-worthy server rather than a new port
 * per request.
 */
import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import request from "supertest";
import { createApp } from "./app.js";
import { createLogger } from "@medicore/logger";
import { listening } from "./test/appServer.js";

const opened: http.Server[] = [];

/** Listen, and remember it, so no test can leak a listener into the next one. */
function decoy(port: number, host?: string): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "x-answered-by": "decoy" });
      res.end();
    });
    opened.push(server);
    server.once("error", reject);
    if (host === undefined) server.listen(port, () => resolve(server));
    else server.listen(port, host, () => resolve(server));
  });
}

function answeredBy(port: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port, path: "/" }, (res) => {
      res.resume();
      resolve(res.headers["x-answered-by"]);
    });
  });
}

afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => new Promise((done) => s.close(done))));
});

describe("test servers bind the loopback address", () => {
  it("gives a suite one server, on 127.0.0.1", async () => {
    const server = await listening(
      createApp(createLogger({ service: "bind-test", level: "silent" })),
    );
    opened.push(server);

    // The wildcard reports "::" here, and that is the whole bug.
    expect(server.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
  });

  it("answers supertest from that same server, without opening a port per request", async () => {
    const server = await listening(
      createApp(createLogger({ service: "bind-test", level: "silent" })),
    );
    opened.push(server);
    const port = (server.address() as { port: number }).port;

    // Three requests, one port. And an `x-request-id` on each, which is the proof that
    // `requestId` — the first middleware — ran, so the answer came from THIS app.
    for (let i = 0; i < 3; i++) {
      const res = await request(server).get("/health");
      expect(res.headers["x-request-id"]).toBeTruthy();
    }
    expect((server.address() as { port: number }).port).toBe(port);
  });

  it("refuses a wildcard ephemeral bind outright, so the mistake cannot be made quietly", () => {
    // What supertest does by default, and what anyone would reach for again.
    expect(() => http.createServer().listen(0)).toThrow(/wildcard/i);
  });

  it("is load-bearing: a wildcard bind would borrow another process's port in silence", async () => {
    const held = await decoy(0, "127.0.0.1");
    const port = (held.address() as { port: number }).port;

    /**
     * An explicit port is left alone by the guard, which is what lets this show the
     * hazard the guard exists to prevent. SO_REUSEADDR — which Node sets — makes this
     * bind SUCCEED even though `held` already has the port on loopback.
     */
    await expect(decoy(port)).resolves.toBeDefined();

    // And the most specific listener wins, so the connection lands on the one that was
    // already there — not on the server that just "successfully" bound the same port.
    await expect(answeredBy(port)).resolves.toBe("decoy");
  });

  it("refuses loudly instead, once the address is specific", async () => {
    const held = await decoy(0, "127.0.0.1");
    const port = (held.address() as { port: number }).port;

    // The same collision, named. This is what a loopback bind turns the silent case
    // into — and why the kernel can no longer hand us a port that is already spoken for.
    await expect(decoy(port, "127.0.0.1")).rejects.toMatchObject({ code: "EADDRINUSE" });
  });
});
