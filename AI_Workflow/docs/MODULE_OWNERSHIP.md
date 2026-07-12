# MODULE OWNERSHIP

Every module has exactly one owning squad (accountable for its spec, quality, and roadmap) — and, in the AI-heavy model, a **human accountable reviewer** whose sign-off is required for merges in safety-critical zones. Until the team is hired, roles are placeholders; update on staffing (and keep current thereafter — stale ownership is how orphan modules rot).

**Squad model (Doc 05 §7):** Platform · Clinical · Financial · Mobile/Experience · Data&AI · (QA + DevOps as guilds).

| Domain / Modules (Doc 02) | Owning squad | Human reviewer required for | Notes |
|---------------------------|--------------|------------------------------|-------|
| A1–A9 Platform/SaaS (tenants, auth, RBAC, audit, notifications, files, domains, API keys) | Platform | auth/RBAC/tenancy changes (**always**) | Connection Manager is the crown jewel |
| B1–B9 Org, facilities, masters, facility ops | Platform (masters) / Clinical (wards, beds) | — | |
| B12 CSSD · B13 Mortuary · C7 MRD | Clinical | statutory register formats | |
| C1–C6 Patient mgmt | Clinical | MPI merge logic | |
| D1–D5 EMR, consultation, teleconsult, nursing | Clinical | **all clinical-safety logic** (allergy/interaction, MAR timing, early-warning) | |
| D6–D9 LIS, RIS, OT, blood bank | Clinical | panic-value pathway, cross-match logic | |
| D10–D14 ED/critical care/dialysis/physio/dietetics | Clinical | triage + ICU calculation logic | |
| E1 Appointments/queue | Experience | — | |
| F1–F3 Billing, insurance, corporate | Financial | **all money math, refunds, claim math** | |
| F4–F5 Pharmacy, inventory | Financial | schedule-drug rules, stock atomicity | |
| F6–F7 Finance GL, HR/payroll | Financial | journal posting rules, payroll statutory | |
| G1–G3 + home healthcare/occupational | Mobile/Experience | offline sync conflict logic | |
| H1 Communication | Experience | patient-facing template defaults | |
| I1–I2 Reporting/dashboards | Data&AI | statutory report formats | |
| J1 AI suite | Data&AI | **guardrails, redaction, prompt changes (always)** | |
| K1 Security/compliance | Platform + external auditor | **always** | |
| Integrations (P7) | Platform | payment + ABDM/NHCX flows | |
| Governance docs (`docs/*`, constitution, memory) | Project owner | constitution amendments (**owner only**) | |

## Rules
1. **Cross-squad changes** need the owning squad's review — module boundaries make this mechanical (touching `modules/billing/**` ⇒ Financial owns the review). Enforce via CODEOWNERS when the repo exists.
2. **AI agents inherit the owner's rules:** an agent working in a module follows that module's reviewer requirements; safety-critical zones above are never merged on AI self-review alone.
3. **Orphan rule:** a module without a current owner cannot take feature changes (bugfixes only) until ownership is reassigned.
4. On-call: squads own their modules' alerts; platform owns golden signals.
