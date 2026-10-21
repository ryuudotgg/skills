export function tilde(text: string, home: string): string {
  const root = home.replace(/\/+$/, "");
  if (!root) return text;

  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?<![^\\s("'=:,])${escaped}/`, "g"), "~/");
}
