# COST OPTIMIZATION

Unit economics discipline: the platform must be profitable at Clinic-edition price points, which means **cost per tenant** is a designed number, not an accident. Owner: platform lead; reviewed monthly against usage telemetry.

## 1. MongoDB (likely #1 cost)

- DB-per-tenant is storage-cheap (DBs are namespaces) but **cluster-tier expensive if oversized**: pack small tenants densely on shared clusters; promote only on measured load (Doc 03 §1.5), not edition vanity.
- Archival tiering (DATA_RETENTION) keeps hot storage ~24 months; time-series + downsampling for vitals cuts the biggest collection ~10×.
- Index hygiene: unused-index report quarterly (indexes cost writes + RAM).
- Atlas: reserved capacity for baseline, auto-scale for peaks; alerts on cluster > 70% sustained.
- **Metric:** DB cost / active tenant / month, per edition.

## 2. Redis

Small footprint by design (no truth stored): right-size by hit-ratio + memory alerts; TTLs mandatory (CACHE_STRATEGY); one cluster serves all tenants — no per-tenant Redis ever.

## 3. Storage (S3/object)

- Lifecycle: hot → infrequent-access at 90 d → archive tier per retention class. Images/PDFs compressed at upload; DICOM is a **paid add-on pack** (Doc 07 §4) because it dominates storage — never bundle unlimited DICOM.
- Per-tenant storage metering feeds plan limits (soft 80% warning is also a sales signal).

## 4. AI APIs (variable cost that can run away)

- Every AI feature is metered per tenant (aiJobs records tokens/cost); AI suite is a **paid add-on** — costs map to revenue by construction.
- Model-tier routing: cheap/fast models (Haiku-class) for OCR cleanup, classification, drafts; premium models (Sonnet/Opus-class) only where quality is clinical-facing; batch/queued processing over realtime where UX allows.
- Caching: prompt-prefix caching for repeated system prompts; embedding reuse (never re-embed unchanged docs).
- Budget alarms per tenant + platform; kill switch `ops.ai-suggestions.enabled` (FEATURE_ROLLOUT §5).

## 5. SMS (most expensive message channel)

- Channel policy: **push (free) → WhatsApp (cheap) → SMS (last resort)** per notification category and recipient reachability; SMS reserved for OTP + critical reminders where no app/WhatsApp presence.
- DLT-registered templates (India), sender-ID pooling, per-tenant SMS metering — overages billable (Doc 07 limits).
- **Metric:** messaging cost / appointment.

## 6. WhatsApp Business API

Conversation-window aware: batch notifications into open 24 h service windows; template messages only when needed; per-category opt-out honored (also compliance). Cheaper than SMS per message but watch conversation-based pricing.

## 7. Email

Bulk (reports/newsletters) via cheap provider; transactional (OTP/receipts) via high-deliverability provider. Attachments as links to signed URLs, never blobs (cuts size + enables expiry).

## 8. CDN / Egress

Static apps + assets on CDN (near-zero origin egress); signed-URL downloads direct from object storage (bypass API pods); report PDFs generated once, cached; beware cross-AZ Mongo↔app traffic — co-locate.

## 9. Compute

Autoscale floors low at night per region (hospital traffic is diurnal); workers scale by queue depth to zero-ish floor; spot/preemptible for stateless workers (jobs are idempotent by rule, so this is safe).

## 10. Governance

- Cost dashboards per subsystem + per tenant; unit metrics: **infra cost per active tenant, per bed, per appointment**.
- New feature PRs that add a metered external call (SMS/AI/gateway) must state expected unit cost in the description.
- Quarterly: top-10 tenants by cost vs revenue review (upsell or optimize).
