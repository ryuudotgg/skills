import { startHub } from "./hub.ts";

export { startHub, type HubOptions, type RunningHub } from "./hub.ts";

if (import.meta.main) {
  const hub = await startHub({
    data: process.env.HUB_DATA ?? "/data",
    listen: process.env.HUB_LISTEN ?? ":8080",
    log: (line) => process.stdout.write(`${line}\n`),
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void hub.stop().then(() => process.exit(0));
    });
}
