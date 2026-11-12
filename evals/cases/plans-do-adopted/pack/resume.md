# Resume 001 adopt-me

Intent: `formatDuration` prints `h:mm:ss` from an hour up and `m:ss` below it.

Done and verified: the commit on feat/adopt-me adds the two hour cases to test/duration.test.js. They fail on the base, as they should.

Current state: src/duration.js carries an uncommitted edit that adds the hours branch. It is half done: minutes are not padded once hours show, so 3725 prints `1:2:05` and the hour test still fails. The minutes and seconds test passes.

Next steps: pad minutes to two digits in the hours branch only, then run `npm test` and see both tests pass.

Key files: src/duration.js, test/duration.test.js.

Gotchas: below an hour the minutes stay unpadded, `0:59` and `1:05`, which the first test pins.

Untracked files: none.

Operator constraints: "keep the signature as it is".
Alternatives rejected: Intl.DurationFormat, since Node's support is not guaranteed on every machine that runs this.
Promises not yet delivered: none.
