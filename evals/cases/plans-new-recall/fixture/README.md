# vault

A document store with one server side module, the share link API in `src/share.js`. Nothing outside the server calls it, and the repo has no route or UI.

`createShareLink` returns a link that opens one document read only, and `openShareLink` opens it.
