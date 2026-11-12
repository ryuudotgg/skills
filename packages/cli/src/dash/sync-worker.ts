import { shortSync } from "../hub/sync.ts";

declare const self: Worker;

self.onmessage = async (event: MessageEvent<NodeJS.ProcessEnv>) => {
  self.postMessage(await shortSync(event.data, true));
};
