# Local host-port ownership

One developer machine runs more than one project, and several of them are
multi-tenant systems built on the same platform — so they share defaults:
**every Mongo replica set is conventionally named `rs0`** and the master database
is `paperlesstech_master` in more than one of them. That combination is a trap: a
driver that reaches the wrong Mongo cannot tell, because the set name and the
database name both look right. The only things keeping the projects apart on one
machine are **the host port** and **the replica-set name** — so this project
deliberately owns a unique value for each.

## MediCore HMS (this repo)

| Service | Host port                   | Notes                                                             |
| ------- | --------------------------- | ----------------------------------------------------------------- |
| Mongo   | `127.0.0.1:37018`           | Replica set **`hms0`** (not `rs0`), no auth (dev). Loopback bind. |
| Redis   | `127.0.0.1:6380`            |                                                                   |
| API     | `4000`                      |                                                                   |
| Web     | `3000`                      |                                                                   |
| Admin   | `3001`                      |                                                                   |
| MinIO   | `9000` / `9001`             |                                                                   |
| Mailhog | `8025` (UI) / `1025` (SMTP) |                                                                   |

Two things make HMS impossible to confuse with a neighbour:

- **A dedicated port, `37018`** — nothing else on the machine uses it (the common
  27017/27018 are taken by the school project below).
- **A named replica set, `hms0`** — a client that pins `replicaSet=hms0` refuses a
  server that answers `rs0`.

Belt-and-suspenders, the API also runs a **boot-time identity check**:
`MONGO_EXPECT_MEMBER=localhost:37018` in `apps/api/.env`. On startup it asks Mongo
who it is and refuses to run if the answer is anything else — so a misconnection
fails loudly instead of reading or writing a stranger's database.

## Other projects on this machine

| Project           | Service                                 | Host port         | Notes                                                          |
| ----------------- | --------------------------------------- | ----------------- | -------------------------------------------------------------- |
| school_management | Mongo (local container)                 | `127.0.0.1:27017` | Replica set `rs0`, **auth + keyfile**.                         |
| school_management | Mongo (VPS, via SSH tunnel for Compass) | `127.0.0.1:27018` | `ssh -L 27018:127.0.0.1:27017 …`. Its own project, left as-is. |

## Rules that keep them apart

1. **Every project owns a distinct Mongo host port.** HMS is `37018`; the school
   local container is `27017`; the school VPS tunnel is `27018`. No two are equal,
   so none can shadow another.
2. **Never bind two things to the same host port** — not even on different
   interfaces. Docker publishing `0.0.0.0:PORT` and an SSH tunnel binding
   `127.0.0.1:PORT` both "succeed", and then the more-specific loopback bind
   silently wins for local clients. HMS binds Mongo/Redis to `127.0.0.1`
   specifically, so a second listener on the same port fails to bind and says so.
3. **If you must add a port, add it here first.** A thirty-second check against
   this table is cheaper than an afternoon spent wondering why a write "worked"
   but the data is in another project's database.
