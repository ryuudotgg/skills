export type Io = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  capture: boolean;
};

export function processIo(): Io {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    capture: false,
  };
}
