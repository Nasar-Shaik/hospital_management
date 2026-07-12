# TESTING — How to run and test locally

The single most common confusion: **`pnpm docker:dev` does not start the application.** It starts only the _infrastructure_ the application needs (databases, cache, storage, mail). Nothing listens on port 4000 after it — you start the apps yourself with `pnpm dev`.

```
pnpm docker:dev   →  mongo, redis, minio, mailhog        (infrastructure)
pnpm dev          →  api, workers, web, admin            (the actual apps)
```

Run both, in that order, in two terminals.

---

## 1. Ports

| What                    | Port    | URL                                               | Started by        |
| ----------------------- | ------- | ------------------------------------------------- | ----------------- |
| **API (Express)**       | `4000`  | http://localhost:4000/health                      | `pnpm dev`        |
| Workers (BullMQ)        | `4100`  | http://localhost:4100/health                      | `pnpm dev`        |
| Web (Next.js)           | `3000`  | http://localhost:3000                             | `pnpm dev`        |
| Admin console (Next.js) | `3001`  | http://localhost:3001                             | `pnpm dev`        |
| MongoDB                 | `27018` | `mongodb://127.0.0.1:27018`                       | `pnpm docker:dev` |
| Redis                   | `6380`  | `redis://127.0.0.1:6380`                          | `pnpm docker:dev` |
| Mailhog (fake inbox)    | `8025`  | http://localhost:8025                             | `pnpm docker:dev` |
| MinIO console (S3)      | `9001`  | http://localhost:9001 (`minioadmin`/`minioadmin`) | `pnpm docker:dev` |

**Mongo is on 27018 and Redis on 6380, not their defaults.** Another project on this machine already binds 27017/6379. Do not "fix" these back — the container-internal ports are standard; only the host mapping differs.

**Almost all API testing happens on port 4000.** The web apps (3000/3001) currently render a health page only — there is no login screen yet, because Phase 1B built the authentication _backend_. The login UI arrives with the app shell.

---

## 2. First-time setup (once)

```bash
pnpm install
pnpm docker:dev                       # infrastructure

cp apps/api/.env.example apps/api/.env
cp apps/workers/.env.example apps/workers/.env
cp apps/web/.env.example apps/web/.env
cp apps/admin/.env.example apps/admin/.env
```

Then put real secrets in `apps/api/.env` — **the API refuses to start without them**, on purpose (a default signing secret is how a dev key ends up in production):

```bash
openssl rand -base64 48    # paste as API_JWT_SECRET
openssl rand -base64 32    # paste as API_ENCRYPTION_KEY
```

> If `apps/api/.env` already has these two lines, you are done — they were generated for you.

---

## 3. Run it

```bash
# terminal 1 — infrastructure (leave running)
pnpm docker:dev

# terminal 2 — the apps
pnpm dev
```

Check it is alive:

```bash
curl http://localhost:4000/health     # {"status":"ok",...}          ← no tenant needed
curl http://localhost:4000/ready      # {"checks":{"mongo":"up","redis":"up"}}
```

If `/ready` says `mongo: down`, your infrastructure isn't up — run `pnpm docker:dev`.

> **"Port 4000 already in use"?** You have the app _containers_ running from a previous `--profile apps` run. They also want 4000. Stop them with `pnpm docker:dev:down` and start again — or, if you want to test the fully containerized build instead, see §8.

---

## 4. Create a hospital to test against

Nothing is testable until a hospital exists. **There is deliberately no signup endpoint** — creating a hospital is an operator action, so no unauthenticated route can ever create one.

```bash
pnpm --filter @medicore/api provision -- \
     --name "Demo Hospital" --slug demo --plan PLAN_CLINIC \
     --admin-email admin@demo.test --admin-password 'Demo!Passw0rd#2026'
```

This creates the database `hms_demo`, runs its migrations, seeds the system roles, and creates the first administrator. If you omit `--admin-password`, a strong one is generated and **printed once** — copy it, it is not recoverable.

---

## 5. The key idea before you test anything

**The `Host` header picks the hospital.** Every `/api/v1/*` request is resolved to exactly one hospital's database _before any handler runs_, using the hostname. So `Host: demo.paperlesstech.in` means "the demo hospital", and there is no other way to say it — no `tenantId` in the URL, no header you can forge.

That's why every command below sets a `Host` header. `/health` and `/ready` are the exceptions — they must work without a hospital.

---

## 6. Test the whole auth flow (copy-paste)

Paste this whole block into a terminal:

```bash
H='Host: demo.paperlesstech.in'
API=http://localhost:4000/api/v1

# ── login ────────────────────────────────────────────────────────────────
LOGIN=$(curl -s -X POST $API/auth/login -H "$H" -H 'Content-Type: application/json' \
        -d '{"email":"admin@demo.test","password":"Demo!Passw0rd#2026"}')
echo "$LOGIN"

ACCESS=$(echo "$LOGIN"  | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['accessToken'])")
REFRESH=$(echo "$LOGIN" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['refreshToken'])")

# ── who am I ─────────────────────────────────────────────────────────────
curl -s $API/auth/me -H "$H" -H "Authorization: Bearer $ACCESS"

# ── my logged-in devices ─────────────────────────────────────────────────
curl -s $API/auth/sessions -H "$H" -H "Authorization: Bearer $ACCESS"

# ── refresh (returns a NEW refresh token — the old one is now spent) ──────
curl -s -X POST $API/auth/refresh -H "$H" -H 'Content-Type: application/json' \
     -d "{\"refreshToken\":\"$REFRESH\"}"

# ── logout, then prove the token is dead ─────────────────────────────────
curl -s -X POST $API/auth/logout -H "$H" -H "Authorization: Bearer $ACCESS" \
     -H 'Content-Type: application/json' -d '{}'
curl -s $API/auth/me -H "$H" -H "Authorization: Bearer $ACCESS"    # → HMS-AUTH-002
```

### The security behaviours worth seeing for yourself

```bash
# Wrong password, unknown email, and a disabled account are INDISTINGUISHABLE.
# Login is not a way to discover who has an account here.
curl -s -X POST $API/auth/login -H "$H" -H 'Content-Type: application/json' \
     -d '{"email":"admin@demo.test","password":"wrong"}'          # → HMS-AUTH-001
curl -s -X POST $API/auth/login -H "$H" -H 'Content-Type: application/json' \
     -d '{"email":"ghost@demo.test","password":"wrong"}'          # → HMS-AUTH-001 (identical)

# An unknown hospital is rejected before credentials are even looked at.
curl -s -X POST $API/auth/login -H 'Host: nosuch.paperlesstech.in' \
     -H 'Content-Type: application/json' \
     -d '{"email":"admin@demo.test","password":"Demo!Passw0rd#2026"}'   # → HMS-TEN-001

# REFRESH TOKEN THEFT. Rotate once, then replay the old token — the whole
# session family is destroyed, for the thief AND the real user.
NEW=$(curl -s -X POST $API/auth/refresh -H "$H" -H 'Content-Type: application/json' \
      -d "{\"refreshToken\":\"$REFRESH\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['data']['refreshToken'])")
curl -s -X POST $API/auth/refresh -H "$H" -H 'Content-Type: application/json' \
     -d "{\"refreshToken\":\"$REFRESH\"}"     # → HMS-AUTH-003 reuse detected
curl -s -X POST $API/auth/refresh -H "$H" -H 'Content-Type: application/json' \
     -d "{\"refreshToken\":\"$NEW\"}"         # → HMS-AUTH-002, the good token died too
```

### Cross-hospital rejection — the most important test in the system

Provision a second hospital, then try to use the first one's token on it:

```bash
pnpm --filter @medicore/api provision -- --name "Other Hospital" --slug other \
     --admin-email admin@other.test --admin-password 'Other!Passw0rd#2026'

curl -s $API/auth/me -H 'Host: other.paperlesstech.in' -H "Authorization: Bearer $ACCESS"
# → HMS-TEN-003 Tenant mismatch
```

The token's signature is perfectly valid. It is refused because it was minted for `demo`, and the hostname selected `other`'s database. **The host picks the database, the token proves the user, and the two must agree.** Neither alone is enough.

---

## 7. Testing from a browser

Two things make browser testing awkward, and both are by design:

1. **You cannot set a `Host` header from the URL bar.** You must make the hostname real.
2. **There is no login page yet.** The web apps only render a health card today.

To browse the API by hostname, add the hospitals to your hosts file (one-time):

```bash
sudo sh -c 'echo "127.0.0.1 demo.paperlesstech.in other.paperlesstech.in" >> /etc/hosts'
```

Now these work in the browser:

- http://localhost:4000/health — liveness (no hospital needed)
- http://demo.paperlesstech.in:4000/api/v1/auth/me — returns `HMS-AUTH-002` without a token, which is correct
- http://localhost:3000 — the web app (health card)
- http://localhost:3001 — the admin console (health card)

For real request-building in a browser-like tool, import into **Postman / Insomnia / VS Code REST Client**: set the base URL to `http://localhost:4000/api/v1`, add the header `Host: demo.paperlesstech.in` to every request, and put the access token in `Authorization: Bearer …`.

---

## 8. Fully containerized run (optional)

This builds real production images for all four apps and runs everything in Docker. Use it to check the Docker build, not for day-to-day development (no hot reload).

```bash
docker compose -f infra/docker/docker-compose.yml --profile apps up --build
```

Same ports as above. **Do not run this at the same time as `pnpm dev`** — they both want 4000/3000/3001/4100. Stop with `pnpm docker:dev:down`.

---

## 9. Automated tests

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # full quality gate
pnpm boundaries                                          # module boundary rules
pnpm --filter @medicore/api test:int                     # 46 integration tests
```

`test:int` needs `pnpm docker:dev` running. It covers 17 tenant-isolation tests and 29 authentication tests against a **real** MongoDB and Redis, and it **fails rather than skips** if either is missing — a silently skipped isolation suite looks exactly like a passing one.

---

## 10. When something goes wrong

| Symptom                                          | Cause and fix                                                                                                        |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| API exits immediately at startup                 | `API_JWT_SECRET` or `API_ENCRYPTION_KEY` missing from `apps/api/.env`. It fails fast on purpose — see §2.            |
| `EADDRINUSE :4000`                               | App containers from a `--profile apps` run are still up. `pnpm docker:dev:down`, then `pnpm docker:dev && pnpm dev`. |
| `/ready` shows `mongo: down`                     | Infrastructure isn't running. `pnpm docker:dev`.                                                                     |
| `HMS-TEN-001 Organization not found`             | The `Host` header doesn't match a provisioned hospital. Check the slug, and that you provisioned it (§4).            |
| `HMS-AUTH-002` on every request                  | Missing/expired/logged-out access token. Access tokens live 15 minutes — log in again or use `/auth/refresh`.        |
| `HMS-AUTH-001` with a password you know is right | You hit the lockout: 5 failed attempts locks the account for 15 minutes. Wait it out, or re-provision.               |
| `getaddrinfo ENOTFOUND mongodb`                  | A Mongo URI is missing `directConnection=true`. Never remove it in dev — see `AI_Workflow/PROJECT_MEMORY.md` §8.     |

---

## 11. What you cannot test yet

Not bugs — not built:

- **Any business feature** (patients, appointments, billing…). Phase 2+.
- **Permission enforcement.** Roles exist and ride inside the token, but the `authorize` middleware lands in Phase 1C, so a logged-in admin is not yet _restricted_ by permissions.
- **Forgot/reset password.** Deliberately postponed until the notification channel exists — a reset flow that cannot deliver a reset is worse than none.
- **A login UI.** The auth backend is complete and testable via HTTP; the screens come with the app shell.
