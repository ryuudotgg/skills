import type { Suite } from "../registry.ts";
import { colorEnabled, painter, tilde } from "../terminal.ts";

type Finished = { seconds: number; output: string; flaky: readonly string[] };

export type SuiteState = { name: string; estimate: number } & (
  | { status: "queued" }
  | { status: "running"; started: number }
  | { status: "rerun"; seconds: number }
  | ({ status: "ok" } & Finished)
  | ({ status: "fail" } & Finished)
);

export type ViewOptions = {
  repo: string;
  home: string;
  color: boolean;
  started: number;
  now: number;
  stopped: boolean;
};

export type LiveOptions = {
  color: boolean;
  home: string;
  columns: () => number;
};

export type Outcome = { failed: boolean } & Finished;

export type Reporter = {
  start(suite: Suite): void;
  hold(suite: Suite, seconds: number): void;
  finish(suite: Suite, outcome: Outcome): void;
  end(complete: boolean): void;
};

type Paint = ReturnType<typeof painter>;

const label = "running".length;
const hide = "\u001b[?25l";
const show = "\u001b[?25h";

function cell(text: string, paint: (text: string) => string, detail: string): string {
  return `${paint(text)}${" ".repeat(label - text.length)}  ${detail}`;
}

function status(state: SuiteState, options: ViewOptions, paint: Paint): string {
  switch (state.status) {
    case "queued":
      return paint.dim(options.stopped ? "not run" : "queued");

    case "running": {
      if (options.stopped) return paint.yellow("stopped");

      const elapsed = Math.max(0, (options.now - state.started) / 1000);
      const estimate =
        elapsed < state.estimate ? paint.dim(` of ~${Math.ceil(state.estimate)}s`) : "";

      return cell("running", paint.cyan, `${Math.floor(elapsed)}s${estimate}`);
    }

    case "rerun":
      return cell("rerun", paint.yellow, paint.dim(`failed in ${state.seconds.toFixed(1)}s`));

    case "ok":
      return cell("ok", paint.green, paint.dim(`${state.seconds.toFixed(1)}s`));

    case "fail":
      return cell("FAIL", (text) => paint.bold(paint.red(text)), `${state.seconds.toFixed(1)}s`);
  }
}

function plural(count: number): string {
  return `${count} suite${count === 1 ? "" : "s"}`;
}

export function renderTable(states: readonly SuiteState[], options: ViewOptions): string[] {
  const paint = painter(options.color);
  const width = Math.max(0, ...states.map((state) => state.name.length));

  return [
    "",
    `${paint.bold("skills test")}${paint.dim(" · ")}${tilde(options.home)(options.repo)}`,
    "",
    ...states.map((state) => `  ${state.name.padEnd(width)}  ${status(state, options, paint)}`),
  ];
}

function summary(
  states: readonly SuiteState[],
  failed: readonly string[],
  flaky: number,
  options: ViewOptions,
  paint: Paint,
): string {
  const total = `${((options.now - options.started) / 1000).toFixed(1)}s`;
  const count = plural(states.length);
  const names = failed.join(", ");
  if (options.stopped) {
    const finished = states.filter((state) => state.status === "ok" || state.status === "fail");
    const failures = failed.length ? `, ${failed.length} failed: ${names}` : "";
    return paint.yellow(
      `Stopped after ${total} with ${finished.length} of ${count} finished${failures}`,
    );
  }

  if (failed.length) return paint.red(`${failed.length} of ${count} failed in ${total}: ${names}`);

  return paint.green(`${count} passed in ${total}${flaky ? `, ${flaky} flaky` : ""}`);
}

export function renderEnd(states: readonly SuiteState[], options: ViewOptions): string {
  if (!states.length) return "No suites to run.\n";

  const paint = painter(options.color);
  const failed = states.filter((state) => state.status === "fail");
  const sections = failed.map((state) => {
    const output = state.output.replace(/^\s*\n/, "").trimEnd();
    const header = `${paint.bold(paint.red("FAIL"))} ${paint.bold(state.name)} ${paint.dim(`${state.seconds.toFixed(1)}s`)}`;
    return `\n${header}\n\n${output || paint.dim("no output")}\n`;
  });

  const flaky = states
    .flatMap((state) => (state.status === "ok" || state.status === "fail" ? state.flaky : []))
    .map((test) => `${paint.yellow("flaky")} ${test}\n`);

  const names = failed.map((state) => state.name);
  const end = summary(states, names, flaky.length, options, paint);
  return `${sections.join("")}${flaky.length ? `\n${flaky.join("")}` : ""}\n${end}\n`;
}

export function liveView(
  stream: NodeJS.WriteStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): LiveOptions | undefined {
  if (stream.isTTY !== true || env.TERM === "dumb") return undefined;
  return { color: colorEnabled(env), home: env.HOME ?? "", columns: () => stream.columns || 80 };
}

function height(lines: readonly string[], columns: number): number {
  return lines.reduce(
    (total, line) => total + Math.max(1, Math.ceil(Bun.stringWidth(line) / columns)),
    0,
  );
}

export function liveReporter(
  repo: string,
  suites: readonly Suite[],
  write: (text: string) => void,
  live: LiveOptions,
): Reporter {
  const started = performance.now();
  const states: SuiteState[] = suites.map((suite) => ({
    name: suite.name,
    estimate: suite.seconds,
    status: "queued",
  }));

  const view = (stopped: boolean): ViewOptions => ({
    repo,
    home: live.home,
    color: live.color,
    started,
    now: performance.now(),
    stopped,
  });

  let drawn = 0;
  let shown = "";
  let ended = false;
  const draw = (stopped = false) => {
    if (!states.length) return;

    const lines = renderTable(states, view(stopped));
    const frame = lines.map((line) => `${line}\n`).join("");
    if (frame === shown) return;

    write(`${drawn ? `\u001b[${drawn}A\r\u001b[J` : hide}${frame}`);
    drawn = height(lines, Math.max(1, live.columns()));
    shown = frame;
  };

  const settle = (suite: Suite, state: SuiteState) => {
    if (ended) return;
    states[states.findIndex((row) => row.name === suite.name)] = state;
    draw();
  };

  draw();
  const timer = setInterval(draw, 250);
  timer.unref();

  return {
    start(suite) {
      settle(suite, {
        name: suite.name,
        estimate: suite.seconds,
        status: "running",
        started: performance.now(),
      });
    },
    hold(suite, seconds) {
      settle(suite, { name: suite.name, estimate: suite.seconds, status: "rerun", seconds });
    },
    finish(suite, { failed, ...finished }) {
      settle(suite, {
        name: suite.name,
        estimate: suite.seconds,
        status: failed ? "fail" : "ok",
        ...finished,
      });
    },
    end(complete) {
      if (ended) return;

      clearInterval(timer);
      draw(!complete);
      ended = true;
      write(`${drawn ? show : ""}${renderEnd(states, view(!complete))}`);
    },
  };
}
