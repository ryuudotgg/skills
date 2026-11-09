---
id: 001
slug: signed-share-links
project: Vault
ctx: -
pri: P1
effort: S
blocked_by: -
surface: the share link API in src/share.js, server side only, no user visible change
critical: true
created: 2026-10-25
---

# 001 signed-share-links

## Outcome

Share links carry an HMAC signature and expire after seven days.

## Acceptance

1. `npm test` passes a test where a link whose token was altered does not open its document.
2. `npm test` passes a test where a link seven days old does not open its document.

## Probe

    rg -n "createShareLink|openShareLink" src

a. Links already carry a signature: close as DROPPED.
b. Links carry no signature: proceed.
c. No hits: stop and re-derive intent with the operator.

## Constraints

A link opens one document read only, and nothing else in the workspace.

## Landed

Merged as abc1234 (PR 7, branch feat/signed-share-links).
`createShareLink` signs each link id with HMAC SHA-256 and stamps an expiry seven days out, and `openShareLink` refuses a link whose token does not verify or whose expiry has passed.
Revocation was left out of this plan.
