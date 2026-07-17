# DATA RETENTION POLICY

Per-data-class retention, archival, and deletion rules. Implemented via `retentionPolicies` (per tenant, jurisdiction-configurable — defaults below are India-first) and the archival jobs in SCHEDULER_CATALOG. Legal hold overrides everything.

## 1. Retention Schedule (defaults; per-tenant/jurisdiction overrides allowed upward, never below statutory minimum)

| Data class                                                   | Hot (Mongo)                           | Archive (object storage, encrypted)                        | Delete                                           |
| ------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| Clinical records (EMR, results, reports, summaries) — adults | 24 mo                                 | to 8 yrs (configurable per jurisdiction; some states more) | after retention, if no hold                      |
| Clinical records — minors                                    | 24 mo                                 | until age of majority + 3 yrs (min)                        | after                                            |
| MLC / medico-legal records                                   | 24 mo                                 | permanent unless jurisdiction says otherwise               | never by default                                 |
| Financial (invoices, payments, journals, GST)                | 36 mo                                 | to 8 yrs (statutory)                                       | after                                            |
| Audit logs (PHI/financial access & mutation)                 | 12 mo                                 | to 6 yrs                                                   | after                                            |
| Vitals time-series                                           | 90 d full-resolution                  | downsampled thereafter, archived with the record           | with clinical record                             |
| Notifications/messages (operational)                         | 90 d                                  | —                                                          | 90 d                                             |
| Chat (doctor–patient clinical)                               | 24 mo                                 | with clinical record                                       | with clinical record                             |
| Sessions/tokens/idempotency keys                             | TTL-indexed                           | —                                                          | automatic                                        |
| Uploaded files                                               | follow owning record's class          | same                                                       | same                                             |
| Backups                                                      | per backup policy (35 d PITR window)  | monthly archival snapshots 12 mo                           | rotate                                           |
| SaaS data (master: billing, tickets)                         | active + 24 mo                        | to 8 yrs (financial)                                       | after                                            |
| Terminated tenant DB                                         | read-only 90 d grace (export offered) | encrypted archive 12 mo                                    | purge with owner approval (tenant state machine) |

## 2. Archival Mechanics

Weekly `archive.cold-data` job moves aged documents to object storage (Parquet/JSONL, encrypted, tenant-partitioned) with a manifest; archived data is query-on-demand (export/restore tooling), not live-queryable. Archive is **within the tenant's residency region**. Integrity: checksums in manifest, sampled restore verification quarterly.

## 3. Deletion & Erasure

- Deletion at end-of-retention is a **reviewed batch** (report generated → operator approves → executes), never fully automatic — Constitution §3.9.
- **DSR erasure (GDPR/DPDP):** PHI pseudonymized irreversibly (identifier tokenization) while preserving financial/audit integrity; clinical statutory retention takes precedence over erasure where law requires (documented in the DSR response). All handled through the K1 DSR workflow, fully audited.
- Soft-deleted documents purge after 90 d unless their class retains longer.

## 4. Legal Hold

`legalHold` flag at patient/admission/tenant scope freezes archival-deletion for matching records; holds are audited (who, why, when released); the deletion batch job excludes held records automatically.

## 5. Compliance Mapping

HIPAA (6-yr documentation), DPDP (purpose limitation + erasure), GDPR (Art. 17 with Art. 17(3)(b) statutory carve-out), Indian state clinical-establishment rules (3–8 yr clinical records), GST (8 yr financial). Evidence: retention config + archival manifests + deletion approvals exportable as a compliance pack (Doc 07 add-on).
