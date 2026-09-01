/**
 * No test server may bind the wildcard address. See test/appServer.ts for what that
 * costs when it happens: the request is silently answered by whatever other process
 * on this machine holds the same port on 127.0.0.1, and the failure surfaces days
 * later as a wandering, un-loggable flake in an unrelated suite.
 *
 * `listening()` is the supported way to get a test server, and it binds loopback.
 * This makes the unsupported way — the one supertest takes by default, and the one
 * anyone would reach for again — fail at the bind instead of a week later.
 */
import http from "node:http";

/** Every overload of `listen`, seen as the one variadic call this wrapper forwards. */
const listen = http.Server.prototype.listen as unknown as (
  this: http.Server,
  ...args: unknown[]
) => http.Server;

http.Server.prototype.listen = function (this: http.Server, ...args: unknown[]) {
  if (args[0] === 0 && typeof args[1] !== "string") {
    throw new Error(
      "listen(0) binds the wildcard address, which can be silently handed a port another " +
        "process already holds on 127.0.0.1 — use listening(app) from src/test/appServer.ts.",
    );
  }
  return listen.apply(this, args);
} as typeof http.Server.prototype.listen;
