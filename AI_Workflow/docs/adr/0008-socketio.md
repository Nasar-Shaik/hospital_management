# ADR-0008: Socket.IO for Realtime

**Status:** Accepted · **Date:** 2026-07-12

## Context

Queue boards, bed boards, chat, notifications, and ICU monitoring need server-push to web and React Native clients, across multiple API pods, with tenant-scoped authorization.

## Decision

Socket.IO with domain namespaces (`/queue`, `/beds`, `/chat`, `/notifications`, `/monitoring`), tenant/branch-scoped rooms (`t:{tenantId}:b:{branchId}:…`), JWT auth on connect, the same permission checks as REST, and the Redis adapter for horizontal scale.

## Consequences

- Works through hospital proxies (fallback transports), first-class RN client, rooms map cleanly to tenancy.
- Realtime is **advisory delivery, not truth**: clients reconcile via REST on reconnect; no business state lives only in socket events.
- Sticky sessions or WebSocket-aware LB required (Doc 05 §6.1).

## Alternatives considered

**Raw WebSocket + custom protocol** (reimplements rooms/fallbacks/reconnect). **SSE** (one-way; chat needs duplex). **Pusher/Ably** (recurring cost + breaks on-prem edition).
