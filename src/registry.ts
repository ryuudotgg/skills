export type Context = {
  root: string;
  repo: string;
  bin: string;
  verbs: readonly Verb[];
  suites: readonly Suite[];
};

export type Verb = {
  name: readonly string[];
  usage: string;
  grammar: readonly string[];
  matcher?: { claude: string; codex: string };
  run(args: readonly string[], ctx: Context): Promise<number>;
};

export type Suite = {
  name: string;
  argv: readonly string[];
  cwd?: string;
  files: readonly string[];
  watch: readonly string[];
  seconds: number;
  timeout?: number;
};

export type Area = {
  verbs: readonly Verb[];
  suites: readonly Suite[];
};
