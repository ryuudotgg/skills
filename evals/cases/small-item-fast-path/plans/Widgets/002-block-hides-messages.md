# 002 Block hides messages

## Outcome

In the chat room broadcast path, a member who has blocked the sender does not receive the sender's messages.

## Acceptance

- [ ] broadcastToRoom skips every recipient whose blockedUserIds contains the sender's id.
- [ ] `npm test` passes with a test covering that case.

## Probe

rg -n "broadcastToRoom|blockedUserIds" src/chat test/

## Constraints

See ctx-chat.
