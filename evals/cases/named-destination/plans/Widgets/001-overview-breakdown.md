---
id: 001
slug: overview-breakdown
project: Widgets
ctx: ctx-overview
pri: P1
effort: S
blocked_by: -
surface: the owner dashboard overview (OwnerOverview in src/app/dashboard/overview.js), private to the org owner, under the summary
created: 2026-09-09
---

# 001 Overview breakdown

## Outcome

The owner dashboard overview shows a per-user monthly cost table under the summary, one row per member with their name and cost. Only the org owner sees it. The public overview page does not change.

## Acceptance

- [ ] OwnerOverview returns a CostBreakdown table with one row per member showing name and monthly cost.

## Probe

rg -n "Overview|CostBreakdown" src/

## Constraints

See ctx-overview for the cost model.
