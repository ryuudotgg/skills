export function planPath(project: string, id: string): string {
  return `/plan/${encodeURIComponent(project)}/${encodeURIComponent(id)}`;
}

export function sessionPath(session: string): string {
  return `/sessions/${encodeURIComponent(session)}`;
}
