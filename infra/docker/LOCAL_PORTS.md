# Local host-port ownership

One developer machine runs more than one project, and several of them are
multi-tenant systems built on the same platform — so they share defaults:
**every Mongo replica set is named `rs0`** and the master database is
`paperlesstech_master` in more than one of them. That combination is a trap: a
driver that reaches the wrong Mongo cannot tell, because the set name and the
database name both look right. The only thing keeping the projects apart on one
machine is **the host port**. This file is the registry of who owns what.

## MediCore HMS (this repo)

| Service | Host port                   | Notes                                                                       |
| ------- | --------------------------- | --------------------------------------------------------------------------- |
| Mongo   | `127.0.0.1:27018`           | Replica set `rs0`, no auth (dev). Bound to loopback on purpose — see below. |
| Redis   | `127.0.0.1:6380`            |                                                                             |
| API     | `4000`                      |                                                                             |
| Web     | `3000`                      |                                                                             |
| Admin   | `3001`                      |                                                                             |
| MinIO   | `9000` / `9001`             |                                                                             |
| Mailhog | `8025` (UI) / `1025` (SMTP) |                                                                             |

The API also runs a **cross-cluster safety net**: `MONGO_EXPECT_MEMBER=localhost:27018`
in `apps/api/.env`. On startup it asks Mongo who it is and refuses to run if the
answer is anything other than that member — so a misconnection fails loudly
instead of reading or writing a stranger's database.

## Other projects on this machine

| Project           | Service                                 | Host port         | Notes                                                                                                                     |
| ----------------- | --------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| school_management | Mongo (local container)                 | `127.0.0.1:27017` | Replica set `rs0`, **auth + keyfile**.                                                                                    |
| school_management | Mongo (VPS, via SSH tunnel for Compass) | `127.0.0.1:37017` | Tunnel LOCAL port moved off 27018 — it used to collide with HMS Mongo. Remote side is still `127.0.0.1:27017` on the VPS. |

## Rules that keep them apart

1. **Never bind two projects to the same host port** — not even on different
   interfaces. Docker publishing `0.0.0.0:27018` and an SSH tunnel binding
   `127.0.0.1:27018` both "succeed", and then the more-specific loopback bind
   silently wins for local clients. That is exactly the incident this file exists
   to prevent. HMS now binds Mongo/Redis to `127.0.0.1` specifically, so a second
   listener on the same port fails to bind and says so.
2. **Admin SSH tunnels pick a port no local service owns.** For the school VPS,
   that is `37017` (see its `deploy/DEPLOYMENT_GUIDE.md`), never `27018`.
3. **If you must add a port, add it here first.** A thirty-second check against
   this table is cheaper than an afternoon spent wondering why a write "worked"
   but the data is in another project's database.
