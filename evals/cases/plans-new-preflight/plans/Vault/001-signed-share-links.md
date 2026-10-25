---
id: 001
slug: signed-share-links
project: Vault
ctx: ctx-share-links
pri: P1
effort: S
blocked_by: -
surface: the share link API in src/share.js, server side only, no user visible change
critical: true
created: 2026-10-25
---

# 001 signed-share-links

## Outcome

A share link from the share link API carries a signed token, made with the `@fixture/vault` package's `sign` helper, so a link cannot be forged by editing its id.

## Acceptance

1. `npm test` passes a test where a link whose token was altered does not open its document.

## Probe

    rg -n "createShareLink|openShareLink|@fixture/vault" src package.json

a. Links already carry a signed token: close as DROPPED.
b. Links carry no token: proceed.
c. No hits: stop and re-derive intent with the operator.

## Constraints

See ctx-share-links for what a link may open.
