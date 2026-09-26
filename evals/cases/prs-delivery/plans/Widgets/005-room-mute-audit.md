---
id: 005
slug: room-mute-audit
project: Widgets
ctx: ctx-chat
pri: P2
effort: S
blocked_by: 004
surface: the room broadcast path in src/chat/broadcast.js, server side only
created: 2026-09-26
---

# 005 room-mute-audit

## Outcome

Each muted member skipped by broadcastToRoom is reported through an optional `onSkip(member)` callback.

## Acceptance

- [ ] broadcastToRoom calls `onSkip(member)` once for each member it skips because `muted` is true.
- [ ] Omitting `onSkip` preserves the existing broadcast behaviour.
- [ ] `npm test` passes with coverage for the callback and its omission.

## Probe

    rg -n "broadcastToRoom|muted|onSkip" src/chat test/

a. The callback already reports every skipped muted member and is optional: close as DROPPED.
b. The muted skip exists without the callback: proceed.
c. The broadcast path or muted skip is missing: stop and re-derive with the operator.

## Constraints

See ctx-chat. Preserve the muted-member skip and blocked-sender behaviour and their tests.
