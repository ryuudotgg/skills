import { digestKey } from "../audit/compare.ts";
import { lines, readDeliveryConfig, type DeliveryConfig } from "../delivery.ts";
import type { Io } from "../io.ts";
import { checkoutIs, detectProject, readCheckout } from "../project.ts";
import { plansDir } from "./index-tsv.ts";
import { resumeEvery, resumeKey } from "./resume.ts";
import { threadsResumeKey, trailProject } from "./threads.ts";

export const sweepKey = "PLANS_SWEEP_EVERY";
export const sweepMinimumMinutes = 5;

export type Schedule =
  | { type: "interval"; everyMs: number }
  | { type: "fixed_time"; timeOfDay: string; weekdays: number[] };

type Reading = { schedule: Schedule } | { off: string };

export type Names = { plans: string | undefined; repo: string | undefined };

type Task = {
  name: string;
  per: "machine" | "plans" | "repo";
  read: (config: DeliveryConfig) => Reading;
};

function single(config: DeliveryConfig, key: string): { value: string } | { off: string } {
  if (config.invalid) return { off: config.notes[0] ?? `${config.path}: invalid config` };

  const values = config.path
    ? lines(config.content)
        .filter((line) => line.startsWith(`${key}=`))
        .map((line) => line.slice(key.length + 1))
    : [];

  if (values.length === 0) return { off: `${key} is unset` };
  if (values.length > 1) return { off: `${config.path}: ${key} is set more than once` };
  return { value: values[0]! };
}

function minutes(key: string, count: number): Reading {
  const everyMs = count * 60_000;
  if (!Number.isSafeInteger(everyMs)) return { off: `${key} is too long to schedule` };
  return { schedule: { type: "interval", everyMs } };
}

export const tasks: readonly Task[] = [
  {
    name: "skills audit digest",
    per: "machine",
    read(config) {
      const setting = single(config, digestKey);
      if ("off" in setting) return setting;
      if (setting.value !== "weekly")
        return { off: `${config.path}: ${digestKey}=${setting.value} is not weekly` };

      return { schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] } };
    },
  },
  {
    name: "plans resume",
    per: "plans",
    read: (config) => everyMinutes(config, resumeKey),
  },
  {
    name: "plans sweep",
    per: "plans",
    read(config) {
      const setting = single(config, sweepKey);
      if ("off" in setting) return setting;
      if (!/^[0-9]+$/.test(setting.value) || Number(setting.value) < sweepMinimumMinutes)
        return {
          off: `${config.path}: ${sweepKey}=${setting.value} is not whole minutes, at least ${sweepMinimumMinutes}`,
        };

      return minutes(sweepKey, Number(setting.value));
    },
  },
  {
    name: "threads resume",
    per: "repo",
    read: (config) => everyMinutes(config, threadsResumeKey),
  },
];

function everyMinutes(config: DeliveryConfig, key: string): Reading {
  const every = resumeEvery(config, key);
  if (every.minutes !== undefined) return minutes(key, every.minutes);
  return { off: every.note ?? `${key} is unset` };
}

export function scheduleLines(names: Names, config: DeliveryConfig): string[] {
  return tasks.map((task) => {
    if (task.per === "plans" && !names.plans)
      return `off ${task.name}: this checkout maps to no plans project`;

    if (task.per === "repo" && !names.repo) return `off ${task.name}: not inside a git repository`;

    const title = task.per === "machine" ? task.name : `${task.name} ${names[task.per]}`;
    const scope = task.per === "machine" ? "machine" : "project";
    const reading = task.read(config);
    return "off" in reading
      ? `off ${title}: ${reading.off}`
      : `task ${scope} ${title}\t${JSON.stringify(reading.schedule)}`;
  });
}

export async function scheduleVerb(
  args: readonly string[],
  usage: string,
  io: Io,
): Promise<number> {
  const project = args[0];
  if (args.length > 1 || project === "" || project?.startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const mismatch = project && (await checkoutIs(io.cwd, project, io));
  if (mismatch) {
    io.err(`schedule: ${mismatch}\n`);
    return 1;
  }

  const plans = (await detectProject(io.cwd, plansDir(io.env), true)) ?? project;
  const inside = (await readCheckout(io.cwd, true, io)).inside;
  const names = { plans, repo: inside ? (plans ?? (await trailProject(io))) : undefined };
  for (const line of scheduleLines(names, readDeliveryConfig(io.env))) io.out(`${line}\n`);
  return 0;
}
