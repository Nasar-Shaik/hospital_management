# ADR-0011: Configuration-First Extensibility (No Executable Plugins in v1)

**Status:** Accepted · **Date:** 2026-07-12

## Context
Requests will come for hospital-specific modules, country-specific compliance, third-party integrations, custom reports and dashboards. A plugin runtime (third-party code executing in the platform) is the classic answer — and a classic source of security, upgrade, and support disasters, especially with PHI in scope.

## Decision
v1 extensibility is **configuration and contracts, not code**:
| Need | Mechanism |
|------|-----------|
| Hospital-specific clinical forms | Clinical template engine + digital form designer (data-driven) |
| Country-specific compliance | Config packs: tax regimes, ID types, statutory registers, coding system (ICD-10/11) per tenant |
| Third-party integrations | Public REST API + scoped API keys + signed webhooks + integration marketplace connectors (built in-house per Doc 01 P7) |
| Custom reports/dashboards | Report builder + dashboard widget config (I1/I2) over read models |
| Custom business rules | Declarative rule configs where designed (reminder timing, discount approval thresholds) — never uploaded scripts |

An in-process plugin SDK is **explicitly deferred**; the module system (Doc 04 §2.4) already gives *first-party* pluggability (modules register behind flags).

## Consequences
- No third-party code touches PHI or the process; upgrades never break customer plugins; support surface stays ours.
- Some bespoke demands will need first-party module work or webhook-based side-systems — acceptable trade.
- Revisit trigger: a marketplace strategy with vetted partners and a sandboxed execution design (separate processes, scoped APIs, resource limits) — new ADR required.

## Alternatives considered
**In-process JS plugins** (PHI + arbitrary code = unacceptable). **Webhook-everything** (kept, as part of the answer). **Low-code embedded scripting (Lua/JS sandbox)** (sandbox escape risk + debugging burden; deferred).
