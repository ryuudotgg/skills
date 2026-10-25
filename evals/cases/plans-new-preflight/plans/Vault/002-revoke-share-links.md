---
id: 002
slug: revoke-share-links
project: Vault
ctx: ctx-share-links
pri: P2
effort: S
blocked_by: 001
surface: the share link API in src/share.js, server side only, no user visible change
critical: true
created: 2026-10-25
---

# 002 revoke-share-links

## Outcome

Admins or editors can revoke a share link through the share link API, and a revoked link no longer opens its document.

## Acceptance

1. `npm test` passes a test where a revoked link does not open its document.
2. `npm test` passes a test where a viewer's revoke is refused.

## Probe

    rg -n "openShareLink|hasRole" src

a. Links can already be revoked: close as DROPPED.
b. No revoke exists: proceed.
c. No hits: stop and re-derive intent with the operator.

## Constraints

See ctx-share-links for what a link may open.
