# RISK REGISTER

Living register. Score = Likelihood (1–5) × Impact (1–5). Review monthly (Sev ≥ 12 weekly). Every risk has an owner and a mitigation that is either **built** (architecture) or **scheduled** (tracker item). Append new risks; never delete — mark Retired with date.

## Technical

| ID | Risk | L×I | Mitigation | Status |
|----|------|-----|-----------|--------|
| T1 | Cross-tenant data exposure via mis-resolved connection or bug | 2×5=10 | DB-per-tenant + host↔JWT match + tenantId stamping + isolation test suite on every route (CI) | Built into design |
| T2 | Fleet migration failure leaves tenant DBs on mixed schema versions | 3×4=12 | Per-tenant migration tracking + convergence metric + expand/contract policy + resume-safe runner | Designed; build in P1 |
| T3 | Connection-pool exhaustion at tenant-count growth | 3×3=9 | LRU caps + metrics + load-test validation (PROJECT_MEMORY assumption A3) | Scheduled P9 |
| T4 | Modular monolith decays into big-ball-of-mud | 3×4=12 | CI boundary enforcement (dep-cruiser) + review rules; never disable the lint | Built into CI from P0 |
| T5 | Read-model drift vs OLTP truth | 3×3=9 | Rebuildable projections + freshness metric + weekly reconciliation job | Design (Doc 03 §9) |
| T6 | Double-charging / duplicate financial postings under retries | 2×5=10 | Idempotency keys + counters + `payment: pending_reconciliation` + financial test suite | Built into design |
| T7 | Master DB becomes a single point of failure | 2×4=8 | Cache-first reads + TTL-extension emergency flag + hourly snapshots (DR §2c) | Designed |

## Business

| ID | Risk | L×I | Mitigation | Status |
|----|------|-----|-----------|--------|
| B1 | Editions mispriced → small clinics unprofitable / hospitals underserved | 3×4=12 | Usage metering from day 1; pricing placeholders reviewed with design partners before GA | Open — owner input (PROJECT_MEMORY §10) |
| B2 | 25-org-type promise creates unbounded specialty scope | 4×3=12 | Flag-gated specialty wave is post-hospital-core; edition demand pulls modules, not sales promises | Governance (Doc 05) |
| B3 | Incumbent lock-in (data migration fear) blocks sales | 4×3=12 | Import tooling (P9) + migration playbooks as first-class product | Scheduled |
| B4 | Design partners shape product toward one hospital's quirks | 3×3=9 | Config-first rule (Constitution §2.3): partner needs become flags/config, never hardcode | Standing rule |

## Operational

| ID | Risk | L×I | Mitigation | Status |
|----|------|-----|-----------|--------|
| O1 | On-call gaps in small team during incidents | 3×4=12 | Runbooks (DR), auto-remediation-first alerts, managed services (Atlas) | Partially designed |
| O2 | Hospital go-lives fail on data quality (bad masters/imports) | 4×4=16 | Import validation tooling + golden master templates + go-live checklist w/ sign-offs | Scheduled P9 — **top operational risk** |
| O3 | Support can't distinguish tenant-specific vs platform issues | 3×3=9 | Tenant drill-down dashboard + traceId in every error | Designed |
| O4 | Untested backups | 2×5=10 | Daily rotating restore-verification (DR §Backup) | Designed |

## Security

| ID | Risk | L×I | Mitigation | Status |
|----|------|-----|-----------|--------|
| S1 | PHI breach (external attack) | 2×5=10 | Field-level encryption, WAF, pen-tests, scanning pipeline, least-privilege infra | Scheduled P9 + continuous |
| S2 | Insider misuse (staff browsing records) | 3×4=12 | Access-event auditing + anomaly reports (accounting of disclosures) | Designed (Doc 09 §9) |
| S3 | Compromised tenant admin account | 3×4=12 | MFA enforcement for privileged roles, session anomaly detection, impersonation audit | Designed |
| S4 | Supply-chain (dependency) compromise | 2×4=8 | Lockfiles, scanning, SBOM, minimal-dependency rule (Constitution §6) | Built into CI |

## AI-Specific

| ID | Risk | L×I | Mitigation | Status |
|----|------|-----|-----------|--------|
| A1 | AI agent introduces duplicate/divergent implementations over months | 4×3=12 | Guidelines §3 search-before-create + review checklist + this governance layer | **This layer is the mitigation** |
| A2 | AI-generated code silently weakens a safety/financial check | 2×5=10 | Never-rule 11 + mandatory suites can't be edited in the same PR as features touching them (review rule) | Standing rule |
| A3 | Clinical AI feature harms a patient (wrong suggestion accepted) | 2×5=10 | Advisory-only + licensed-user sign-off + guardrail audits (Doc 01 P8); no autonomous clinical action ever (PROJECT_MEMORY assumption) | Constitutional |
| A4 | PHI leaked into third-party model prompts | 2×5=10 | Redaction layer before provider calls + DPA-gated provider config + prompt audit log | Designed (Doc 02 J1) |
| A5 | Doc/code drift makes AI agents confidently wrong | 4×3=12 | Doc-update matrix (Guidelines §4) + PR checklist + drift = defect culture | Standing rule |
