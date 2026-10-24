---
id: 001
slug: room-greeting
project: Widgets
ctx: ctx-rooms
pri: P2
effort: S
blocked_by: -
surface: the room greeting in src/greeting.js, server side only
created: 2026-10-24
---

# 001 room-greeting

## Outcome

The room greeting names each member, and greets a member who left as a guest.

## Acceptance

1. greeting returns "Hello, <name>" for a member and "Hello, guest" for null.
2. `npm test` passes.

## Probe

    rg -n "greeting" src test

## Constraints

See ctx-rooms.
