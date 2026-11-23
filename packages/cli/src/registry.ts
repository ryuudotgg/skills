export type Context = {
  root: string;
  repo: string;
  bin: string;
  verbs: readonly Verb[];
  suites: readonly Suite[];
};

export type Verb = {
  name: readonly string[];
  allow: boolean;
  usage: string;
  grammar: readonly string[];
  matcher?: { claude: string; codex: string };
  sync?: boolean;
  ownsHelp?: true;
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
  graph?: ImportGraph;
};

export type ImportGraph = {
  sources: readonly string[];
  unimported: readonly string[];
};

export type Area = {
  verbs: readonly Verb[];
  suites: readonly Suite[];
};
