# SEARCH STRATEGY

How every search surface works, per-tenant (each search operates within the tenant's own database — cross-tenant search never exists).

## 1. Patient Search (MPI) — the most important search in the product
- **Inputs:** UHID (exact), phone (exact/last-4), name (fuzzy), ABHA, DOB combos.
- **Implementation tiers:**
  - Tier A (default, all editions): compound indexes (`{tenantId, uhid}`, `{tenantId, contact.phone}`) + Mongo text index on name — exact and prefix fast paths.
  - Tier B (Atlas deployments): **Atlas Search** index per tenant DB — typo tolerance, phonetic (Indian name transliteration variance), weighted fields (phone > uhid > name).
- **Dedup support:** same engine powers registration-time duplicate detection (name+DOB+phone similarity score → `HMS-PAT-002` candidates).
- **Budget:** results < 300 ms p95 (PERFORMANCE_BUDGET).

## 2. Doctor Search
Small cardinality (≤ hundreds/tenant): Mongo regex/prefix on indexed `{tenantId, name, specializationId}` + Redis-cached directory list. Patient-app search adds filters (specialty, availability today, fee range) — served from the cached directory joined with slot availability.

## 3. Medicine Search (prescribing + pharmacy POS)
- Formulary (~10–50k rows, reference DB + tenant overrides): **prefix-optimized index** on brand/generic/composition; served with a debounced typeahead.
- Prescriber view ranks: tenant stock availability first, then formulary; includes strength/form disambiguation.
- POS scan path: barcode → exact batch lookup (no search engine involved).

## 4. Inventory / Item Search
Indexed code/name prefix within `{tenantId, storeId}`; category/ABC filters are indexed facets. No engine needed at expected cardinality (<20k items).

## 5. Global Search (app-wide ⌘K)
Federated: parallel scoped queries (patients, doctors, appointments today, invoices by number, medicines) each with its own index path; results grouped by type; permission-filtered per requester (a cashier's global search never returns clinical notes). No separate search cluster — it's an orchestration layer.

## 6. Atlas Search (when available)
Used for: patient fuzzy/phonetic (above), clinical notes keyword search (doctor's own patients, `emr:read` scope enforced in the filter stage), knowledge base. Index definitions live in IaC (`infra/`), created per tenant DB by the provisioning pipeline; self-hosted deployments (Government on-prem) fall back to Tier A + optional Meilisearch sidecar — same repository interface (`SearchProvider` port), so the app code is identical.

## 7. Vector Search (AI/RAG — Phase 8)
`embeddings` collection with Atlas Vector Search (cosine; dims per model) per tenant DB. Chunking: knowledge-base articles + tenant SOPs; **clinical records are not embedded into shared indexes** — RAG over PHI happens per-request with scoped retrieval, never a pre-built cross-patient semantic index, until a privacy review approves otherwise (note in PROJECT_MEMORY if that changes).

## Rules
- Every search endpoint is paginated + permission-scoped; search never bypasses repositories.
- Search behavior is a `SearchProvider` port with `mongo` (default), `atlas`, (later `meili`) adapters — chosen per deployment config, invisible to modules.
- New search surface ⇒ entry here + index in Doc 03 §4 + budget line in PERFORMANCE_BUDGET.
