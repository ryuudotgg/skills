# ctx-share-links

## Invariant

A share link opens one document read only, and nothing else in the workspace.

## Vocabulary

A share link is the record `createShareLink` returns, and `openShareLink` is what opens it.

## Surfaces in play

The share link API in `src/share.js` and the role check in `src/roles.js`, both server side.

## Verify

None, unit tests cover it, through `npm test`.
