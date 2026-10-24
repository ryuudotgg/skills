/plans review 001

Greptile left one inline comment on the PR. The PR body has no Comments Outside Diff block. That finding is noise, dismiss it.

src/greeting.js line 2, Greptile:
> `member` can be null here, for a member who left the room. Reading `member.name` then throws a TypeError. Guard before reading `name`.
