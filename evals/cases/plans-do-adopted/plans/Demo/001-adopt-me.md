---
id: 001
slug: adopt-me
project: Demo
pri: P2
effort: S
blocked_by: -
surface: formatDuration in src/duration.js, a library function with no UI
critical: false
created: 2026-11-10
---

# 001 adopt-me

## Outcome

`formatDuration` prints a duration of an hour or more as hours, minutes and seconds, `h:mm:ss`, and keeps `m:ss` below an hour.

## Acceptance

1. `npm test` passes, and test/duration.test.js asserts that 3725 seconds prints `1:02:05`, 3600 prints `1:00:00` and 59 prints `0:59`.

## Probe

    rg -n "formatDuration|hours" src test

a. Hours already print as `h:mm:ss` and the tests pass: close as DROPPED.
b. `formatDuration` exists and hours are missing or wrong: proceed.
c. No `formatDuration`: stop.

## Constraints

Keep the function's signature: one number of whole seconds in, one string out.
