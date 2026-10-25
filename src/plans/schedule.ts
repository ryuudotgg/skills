import { digestKey } from "../audit/compare.ts";
import { lines, readDeliveryConfig, type DeliveryConfig } from "../delivery.ts";
import type { Io } from "../io.ts";
import { checkoutIs } from "../project.ts";
import { resumeEvery, resumeKey } from "./resume.ts";

export const sweepKey = "PLANS_SWEEP_EVERY";
export const sweepMinimumMinutes = 5;

export type Schedule =
  | { type: "interval"; everyMs: number }
  | { type: "fixed_time"; timeOfDay: string; weekdays: number[] };

type Reading = { schedule: Schedule } | { off: string };

type Task = {
  title: (project: string) => string;
  scope: "machine" | "project";
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
    title: () => "skills audit digest",
    scope: "machine",
    read(config) {
      const setting = single(config, digestKey);
      if ("off" in setting) return setting;
      if (setting.value !== "weekly")
        return { off: `${config.path}: ${digestKey}=${setting.value} is not weekly` };

      return { schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] } };
    },
  },
  {
    title: (project) => `plans resume ${project}`,
    scope: "project",
    read(config) {
      const every = resumeEvery(config);
      if (every.minutes !== undefined) return minutes(resumeKey, every.minutes);
      return { off: every.note ?? `${resumeKey} is unset` };
    },
  },
  {
    title: (project) => `plans sweep ${project}`,
    scope: "project",
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
];

export function scheduleLines(project: string, config: DeliveryConfig): string[] {
  return tasks.map((task) => {
    const reading = task.read(config);
    return "off" in reading
      ? `off ${task.title(project)}: ${reading.off}`
      : `task ${task.scope} ${task.title(project)}\t${JSON.stringify(reading.schedule)}`;
  });
}

export async function scheduleVerb(
  args: readonly string[],
  usage: string,
  io: Io,
): Promise<number> {
  const project = args[0];
  if (args.length !== 1 || !project || project.startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const mismatch = await checkoutIs(io.cwd, project, io);
  if (mismatch) {
    io.err(`schedule: ${mismatch}\n`);
    return 1;
  }

  for (const line of scheduleLines(project, readDeliveryConfig(io.env))) io.out(`${line}\n`);
  return 0;
}
