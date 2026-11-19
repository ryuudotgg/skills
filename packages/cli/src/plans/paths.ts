export function plansDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLANS_DIR || `${env.HOME ?? ""}/Plans`;
}
