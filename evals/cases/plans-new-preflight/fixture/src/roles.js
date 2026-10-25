export const ROLES = ["owner", "admin", "editor", "viewer"];
export function hasRole(member, role) {
  return ROLES.indexOf(member.role) <= ROLES.indexOf(role);
}
