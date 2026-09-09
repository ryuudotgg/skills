export function slugify(input) {
  return input.trim().toLowerCase().replace(/[^a-z0-9]/g, "-");
}
