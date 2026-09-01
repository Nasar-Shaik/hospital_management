# Radiology (D7) — what v1 is, and what it deliberately is not

**Status: v1 complete, 2026-08-18.**

---

## The workflow, in one line

**Doctor orders → charge raised → payment (advisory at the API, held at the web worklist) →
imaging worklist → accept → start → narrative report (+ film) → verify → release → doctor reads
it.** The same spine as the laboratory, because it is literally the same Order (ADR-0013 §3).

**No radiologist is required at any step.**

---

## Why v1 does not require a radiologist

The lab splits performing from verifying, and that split is a real safety property: the person who
ran the assay must not be the one who certifies the number, because the check is on a
**measurement**.

Imaging is not that. In most hospitals this product is sold to there is no consultant radiologist
on staff: a radiographer takes the film, writes what they saw, and the **treating doctor reads the
image**. There is no second reader to be had, and inventing a requirement for one does not create
a safeguard — it creates an outage. That is exactly what the module had before this milestone:
`radiology:sign` was required to verify a study and only RADIOLOGIST held it, so a hospital without
one could take the film, type the report, and never deliver either.

So `RADIOLOGY_TECHNICIAN` carries a study the whole way.

|                                  | LAB_TECHNICIAN             | RADIOLOGY_TECHNICIAN                    |
| -------------------------------- | -------------------------- | --------------------------------------- |
| `order:read` / `order:perform`   | ✅                         | ✅                                      |
| `order:verify` / `order:release` | ❌ — the pathologist signs | ✅ — no one else may be there           |
| category authority               | —                          | `radiology:sign`                        |
| `file:upload`                    | ✅                         | ✅                                      |
| `emr:read`                       | ❌                         | ❌                                      |
| `order:cancel`                   | ❌                         | ❌ — a doctor calls their own study off |

### `radiology:sign` on a technician is not a loophole

`order.authority.ts` defines the extra permission as _"the one that says they are competent in
THIS category"_ — competence, not seniority. A radiographer is competent in imaging and is not
competent in haematology, which is precisely the distinction the check makes. The technician still
cannot certify a blood result, and the pathologist still cannot sign a scan. Both are pinned in
`orders.int.test.ts`.

### The future radiologist workflow needs no code

A hospital that employs radiologists gets the two-person model by **editing roles**:

- take `order:verify`, `order:release` and `radiology:sign` off RADIOLOGY_TECHNICIAN;
- leave them on RADIOLOGIST, which already holds them and is unchanged by this milestone.

The technician then performs and reports; the radiologist verifies and releases. Same routes, same
state machine, no branch in the code. `orders.int.test.ts` walks that arrangement too, so it is a
supported configuration rather than a theory.

---

## The study catalogue is the tariff

There is **no second catalogue**, deliberately.

The lab has one (`labTests`) because a blood test needs **analytes and reference ranges** — without
them a technician types "Haemoglobin" and "12–15" from memory, and a range typed from memory is how
a normal result gets called abnormal. An imaging study has no analytes. Everything a radiology
catalogue would hold — code, name, price, whether it can be ordered — the tariff already holds, and
the order pad already reads it.

Seeded studies: `XRAY_CHEST_PA`, `XRAY_ABDOMEN`, `XRAY_LIMB`, `USG_ABDOMEN`, `CT_HEAD`.

`ECG` is also filed under `radiology` and is not imaging. That is an existing decision; moving it
would move its billing category on every hospital that has already priced it, so it is left alone
and noted.

## The report is prose

`result.summary` — 5,000 characters, already on the order — is the whole reporting model. Findings
and impression, typed by the person who took the film, with the image attached through the existing
reports infrastructure (`POST /orders/:id/reports`).

The web result form asks for that rather than the lab's analyte grid, and collapses the grid rather
than removing it: a chest X-ray has no numbers, an obstetric ultrasound has BPD/FL/EFW. Common case
by default, the other one click away.

---

## Entitlement — `module.clinical.ris`

It appears in four editions (Diagnostic Centre, Hospital, Hospital Plus, Enterprise) and, until
this milestone, gated **no line of code**. It now gates the one thing that matters.

**Placing** a radiology order requires it (`order.entitlement.ts`, checked in `placeOrder`).

Three things it deliberately does **not** do:

|                                              | Why                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does not gate transitions                    | If the entitlement lapses while a patient is halfway through a CT, refusing `complete` strands a scan already performed: the dose is delivered, the image exists, and the only effect is that the doctor never sees it. An expired subscription must never become a clinical problem. Same reasoning, same shape, as the schema-readiness guard beside it. |
| Does not gate reads                          | A hospital that stops paying for imaging does not lose last year's chest X-ray. Hiding it would be destroying a medical record over an invoice.                                                                                                                                                                                                            |
| Does not gate `lab` on `module.clinical.lis` | The symmetric-looking change is a regression: LIS is not in `CLINIC_FLAGS`, and clinics without it legitimately order bloods and send the sample to an outside laboratory. The lab's flag correctly gates what it actually sells — the test catalogue with its analytes.                                                                                   |

A category with no entry in the map is part of the base product. The refusal is `HMS-PLAN-002`, the
same code `authorize({ feature })` raises, so every client that already says "not in your edition"
needs no second case.

---

## Not built, deliberately

PACS · DICOM · modality integration · barcodes · RIS scheduling · mandatory radiologist sign-off ·
second-reader workflows · structured imaging templates · AI image analysis · external radiology
integrations · an enterprise imaging archive.

`radiology:report` remains `future()` and gates nothing: results ride the order worklist under
`order:perform`, which is where a v1 narrative belongs.

---

## What the tests prove

| Claim                                                                      | Where                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| A study reaches the doctor with no radiologist                             | `orders.int.test.ts` — "radiology runs end to end without a radiologist" |
| The film attaches through the existing reports module                      | same block                                                               |
| Imaging staff cannot open the chart, the film's bytes or the doctor's note | same block                                                               |
| The category wall holds both ways                                          | same block, and the older PATHOLOGIST/RADIOLOGIST test                   |
| A radiologist, where one exists, still signs                               | same block                                                               |
| Forged and cross-tenant order ids refused                                  | same block                                                               |
| The shared state machine gives radiology no dispensation                   | same block                                                               |
| RIS on → works; RIS off → HMS-PLAN-002; lab and procedure unaffected       | "radiology is gated on the module the hospital bought"                   |
| A lapsed entitlement does not strand a study in flight                     | same block                                                               |
| The imaging worklist stops at the branch, for reads AND sign-off           | `branchIsolation.int.test.ts`                                            |
| The form asks imaging for prose                                            | `apps/web/__tests__/imagingReport.test.ts`                               |
| The whole thing works in a browser                                         | `e2e/radiologyWorkflow.spec.ts`                                          |
