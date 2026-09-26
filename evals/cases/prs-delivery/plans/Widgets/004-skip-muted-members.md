---
id: 004
slug: skip-muted-members
project: Widgets
ctx: ctx-chat
pri: P1
effort: XS
blocked_by: -
surface: the room broadcast path in src/chat/broadcast.js, server side only
created: 2026-09-18
---

# 004 skip-muted-members

## Outcome

In the chat room broadcast path, a member whose `muted` flag is true does not receive the room's messages.

## Acceptance

- [ ] broadcastToRoom skips every recipient whose `muted` is true.
- [ ] `npm test` passes with a test covering that case.

## Probe

    rg -n "broadcastToRoom|muted" src/chat test/

a. Members with `muted` true are already skipped: close as DROPPED.
b. `muted` is nowhere in the broadcast path: proceed.
c. broadcastToRoom is gone or renamed: stop and re-derive with the operator.

## Constraints

See ctx-chat. The existing blocked-sender behaviour and its test must keep passing unchanged.
