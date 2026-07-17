# ADR-0009: Authentication — JWT Access + Rotating Refresh Tokens

**Status:** Accepted · **Date:** 2026-07-12

## Context

Six client surfaces (3 web, 3 mobile) authenticate against a multi-tenant API; hospitals need MFA for privileged roles and enterprise SSO; mobile needs long-lived sessions with secure storage.

## Decision

- Short-lived **JWT access tokens** (≤15 min) carrying `{userId, tenantId, roles, branchIds}`; verified statelessly.
- **Rotating refresh tokens** (opaque, hashed at rest, per-device family) with **reuse detection** → family revocation.
- **MFA** (TOTP; mandatory for privileged roles), **SSO/OIDC+SAML** (Enterprise edition), password policy + history, session listing/revocation.
- Tenant users live in the tenant DB (`users`); SaaS operators in master (`superAdminUsers`) — separate realms, no shared credentials.
- Patient-app identity binds to `patientId` with `self` scope only.

## Consequences

- Stateless verification keeps the hot path DB-free; revocation latency bounded by access-token life (accepted; critical revocations also blocklist in Redis).
- JWT `tenantId` must match host-resolved tenant (ADR-0005) — two independent factors select the database.
- We own credential security: bcrypt/argon2, no custom crypto anywhere else (Constitution §11).

## Alternatives considered

**Server sessions only** (Redis dependency on every request; poor mobile fit). **Auth0/Cognito** (cost per MAU across patients breaks unit economics; on-prem edition impossible). **Passkeys** (planned addition, not a replacement — Doc 02 A3 Future).
