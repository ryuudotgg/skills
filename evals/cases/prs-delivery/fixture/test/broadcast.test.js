import test from "node:test";
import assert from "node:assert/strict";
import { broadcastToRoom } from "../src/chat/broadcast.js";

test("blocked senders are skipped", () => {
  const sent = [];
  const room = { members: [
    { id: "a", blockedUserIds: [] },
    { id: "b", blockedUserIds: ["s"] },
  ] };
  broadcastToRoom(room, { id: "s" }, "hi", (m) => sent.push(m.id));
  assert.deepEqual(sent, ["a"]);
});
