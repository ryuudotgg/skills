export function broadcastToRoom(room, sender, message, send) {
  for (const member of room.members) {
    if (member.id === sender.id) continue;
    if (member.blockedUserIds.includes(sender.id)) continue;
    send(member, message);
  }
}
