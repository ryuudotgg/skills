---
id: 001
slug: overview-breakdown
project: Widgets
ctx: ctx-overview
pri: P1
effort: S
blocked_by: -
surface: the overview tab, under the summary
created: 2026-09-09
---

# 001 Overview breakdown

## Outcome

The overview tab shows a per-user monthly cost table under the summary, one row per member with their name and cost.

## Acceptance

- [ ] The overview tab renders a CostBreakdown table with one row per member showing name and monthly cost.

## Probe

rg -n "Overview|CostBreakdown" src/

## Constraints

See ctx-overview for the cost model.
