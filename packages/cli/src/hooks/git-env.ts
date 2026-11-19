const INHERITED_GIT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_DIFF_OPTS",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

export function scrubGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const gitEnv = { ...process.env, ...env };
  for (const name of INHERITED_GIT) delete gitEnv[name];
  return gitEnv;
}
