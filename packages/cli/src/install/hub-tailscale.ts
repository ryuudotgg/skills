import { MISSING, type Peer, type Tailnet } from "../hub/tailscale.ts";
import { isTailnetName } from "./hub.ts";

const HUB_NAME = "skills-hub";

export const NO_TAILSCALE = `HUB_NETWORK=tailscale reads this machine's tailnet, and ${MISSING}`;

export function hubPeers(tailnet: Tailnet): readonly Peer[] {
  if (tailnet.kind !== "up") return [];

  return tailnet.peers
    .filter((peer) => peer.host.toLowerCase().startsWith(HUB_NAME))
    .filter((peer) => isTailnetName(new URL(peer.url).hostname))
    .toSorted((a, b) => Number(b.online) - Number(a.online) || a.url.localeCompare(b.url));
}

export function newHubUrl(tailnet: Tailnet): string | undefined {
  if (tailnet.kind !== "up" || tailnet.suffix === "") return undefined;

  const taken = new Set(tailnet.taken.map((name) => name.toLowerCase()));

  let name = HUB_NAME;
  for (let n = 1; taken.has(name); n += 1) name = `${HUB_NAME}-${n}`;

  return `https://${name}.${tailnet.suffix}`;
}
