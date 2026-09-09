# 001 Overview breakdown

## Outcome

The overview tab shows a per-user monthly cost table under the summary, one row per member with their name and cost.

## Acceptance

- [ ] The overview tab renders a CostBreakdown table with one row per member showing name and monthly cost.

## Probe

rg -n "Overview|CostBreakdown" src/

## Constraints

See ctx-overview for the cost model.
