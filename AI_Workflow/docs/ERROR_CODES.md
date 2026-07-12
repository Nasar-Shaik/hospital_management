# ERROR CODES

The **only** legal source of API error codes. Every thrown `AppError` uses a code from this file; new errors are added here in the same PR (Guidelines §4). Never reuse or renumber a code.

**Scheme:** `HMS-<DOMAIN>-<NNN>` · Response shape: `{ error: { code, message, details?, traceId } }` · Messages are user-safe (no internals); `details` carries field-level info for 400s.

**Retry semantics:** `retryable: yes` means the client may retry idempotently (same Idempotency-Key where applicable).

## Platform & Auth

| Code | HTTP | Message (EN) | Recovery | Retry |
|------|------|--------------|----------|-------|
| HMS-AUTH-001 | 401 | Invalid credentials | Re-enter; lockout after N attempts | no |
| HMS-AUTH-002 | 401 | Session expired | Refresh token / re-login | yes (refresh) |
| HMS-AUTH-003 | 401 | Refresh token reuse detected | Family revoked; force re-login; security alert | no |
| HMS-AUTH-004 | 403 | MFA required | Complete MFA challenge | no |
| HMS-AUTH-005 | 403 | Insufficient permission | Request access from admin | no |
| HMS-TEN-001 | 404 | Organization not found | Check subdomain/domain | no |
| HMS-TEN-002 | 403 | Organization suspended | Contact support/billing | no |
| HMS-TEN-003 | 403 | Tenant mismatch | Token does not belong to this domain; re-login | no |
| HMS-TEN-004 | 503 | Tenant database unavailable | Automatic failover in progress | yes (backoff) |
| HMS-PLAN-001 | 402 | Plan limit reached (`details.metric`) | Upgrade edition or free capacity | no |
| HMS-PLAN-002 | 403 | Feature not in your edition | Upgrade path in `details.requiredEdition` | no |
| HMS-VAL-001 | 400 | Validation failed | Fix `details.fields` | no |
| HMS-REQ-001 | 429 | Too many requests | Respect `Retry-After` | yes |
| HMS-REQ-002 | 409 | Duplicate request (idempotency) | Original response returned in `details` | no |
| HMS-REQ-003 | 409 | Record was modified by someone else | Reload and reapply changes (version conflict) | no |
| HMS-STATE-001 | 422 | Invalid state transition (`details.from→to`) | See STATE_MACHINE_CATALOG | no |

## Patient & Clinical

| Code | HTTP | Message | Recovery | Retry |
|------|------|---------|----------|-------|
| HMS-PAT-001 | 404 | Patient not found | Verify UHID/search | no |
| HMS-PAT-002 | 409 | Possible duplicate patient | Review `details.candidates`; merge or override with permission | no |
| HMS-APT-001 | 409 | Slot no longer available | Pick another slot (`details.alternatives`) | no |
| HMS-APT-002 | 422 | Doctor not available at this time | Check schedule | no |
| HMS-ADM-001 | 409 | Bed already occupied | Bed board refresh; pick another | no |
| HMS-ADM-002 | 422 | Discharge blocked: pending items | Clear `details.blockers` (bill/orders/summary) | no |
| HMS-EMR-001 | 403 | Record is signed and immutable | Create an amendment/new version | no |
| HMS-RX-001 | 422 | Allergy conflict (`details.allergen`) | Licensed override with reason, or change drug | no |
| HMS-RX-002 | 422 | Drug interaction (`details.severity`) | Review; override per policy | no |
| HMS-LAB-001 | 422 | Sample rejected (`details.reason`) | Recollect | no |
| HMS-LAB-002 | 403 | Result approval requires pathologist role | Route to approver | no |

## Financial

| Code | HTTP | Message | Recovery | Retry |
|------|------|---------|----------|-------|
| HMS-BIL-001 | 422 | Bill already finalized | Use credit-note reversal flow | no |
| HMS-BIL-002 | 422 | Discount exceeds your approval limit | Request approval (`details.approverRole`) | no |
| HMS-PAY-001 | 402 | Payment failed at gateway | Retry with same Idempotency-Key or other mode | yes |
| HMS-PAY-002 | 409 | Payment already captured | No action; original receipt in `details` | no |
| HMS-PAY-003 | 422 | Refund exceeds source payment | Correct amount | no |
| HMS-WAL-001 | 422 | Insufficient wallet balance | Top up or change payment mode | no |
| HMS-INS-001 | 422 | Pre-authorization required for this service | Initiate pre-auth (W7) | no |
| HMS-INS-002 | 422 | Claim documents incomplete | Attach `details.missing` | no |
| HMS-PHM-001 | 409 | Insufficient stock (`details.available`) | Partial dispense or backorder | no |
| HMS-PHM-002 | 422 | Batch expired | System blocks; pick valid batch | no |
| HMS-INV-001 | 422 | GRN quantity exceeds PO | Verify receipt; amend PO per policy | no |
| HMS-FIN-001 | 422 | Accounting period closed | Post to open period / reopen with permission | no |

## Files & Integrations

| Code | HTTP | Message | Recovery | Retry |
|------|------|---------|----------|-------|
| HMS-FILE-001 | 413 | File exceeds size limit | Compress/split; limit in `details.max` | no |
| HMS-FILE-002 | 422 | File type not allowed / failed scan | Provide valid file | no |
| HMS-INT-001 | 502 | Upstream service failed (`details.provider`) | Queued for retry where safe | yes (system) |
| HMS-INT-002 | 504 | Upstream timeout | As above | yes (system) |
| HMS-INT-003 | 422 | Webhook signature invalid | Check secret configuration | no |

## Generic

| Code | HTTP | Message | Recovery | Retry |
|------|------|---------|----------|-------|
| HMS-GEN-404 | 404 | Resource not found | Verify ID (within this tenant) | no |
| HMS-GEN-500 | 500 | Something went wrong | Auto-reported with `traceId`; retry once | yes |
| HMS-GEN-503 | 503 | Service in maintenance/read-only | See MAINTENANCE_MODE; retry after window | yes |

**Adding a code:** next number in its domain block; include HTTP, message, recovery, retry; add i18n message keys; write the test that asserts the code is returned.
