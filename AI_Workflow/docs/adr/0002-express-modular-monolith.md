# ADR-0002: Express + TypeScript Modular Monolith

**Status:** Accepted · **Date:** 2026-07-12

## Context
40+ business modules must ship over ~18 months with a small team plus AI agents; hospitals also demand on-prem/single-VM deploys (Government edition).

## Decision
One deployable Express + TypeScript API structured as a **modular monolith**: feature-sliced modules with enforced boundaries (service-interface or event access only, acyclic graph, CI-enforced — Doc 04 §2.4). Workers are a second deployable sharing the same modules.

## Consequences
- One transaction context, one deploy, one debugging surface — the fastest path to a correct HIS.
- Module = future service boundary; the outbox is the seam, so extraction later doesn't rewrite callers.
- Discipline is the price: boundary lint must stay red-line; a big-ball-of-mud is the failure mode if CI enforcement is ever disabled.
- NestJS's DI/decorators were declined to keep the codebase plain and AI-legible; the layering (routes→controller→service→repository) provides the same structure explicitly.

## Alternatives considered
**Microservices** (distributed-systems tax with zero current scale need). **NestJS** (heavier abstraction, hides control flow from generators/reviewers). **Fastify** (viable; Express chosen for ecosystem ubiquity — revisit only with a perf case).
