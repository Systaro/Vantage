/**
 * The one place ops decides who may do what. Routes never check roles themselves: `enforceRoles`
 * maps every request to a permission, and the UI asks `can()` the same table before rendering a
 * button. Anything not listed is readable by every user and writable only by admins (fail closed).
 *
 *   viewer   reads everything except users and the audit log
 *   operator + runs templates, triggers pipeline schedules, cancels runs, manages hosts
 *   admin    + manages users, templates and pipeline schedules (the trigger tokens are secrets)
 */
import type { Context, MiddlewareHandler } from "hono";
import type { SessionUser } from "../shared/auth";

export type Role = "admin" | "operator" | "viewer";
export const ROLES: Role[] = ["viewer", "operator", "admin"];
export const ROLE_LABEL: Record<Role, string> = { admin: "Administrator", operator: "Operator", viewer: "Lesend" };

export type Permission = "read" | "run" | "hosts" | "admin";

const MIN_ROLE: Record<Permission, Role> = { read: "viewer", run: "operator", hosts: "operator", admin: "admin" };
const RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

const RULES: { method: "GET" | "POST"; path: RegExp; perm: Permission }[] = [
  { method: "GET", path: /^\/(users|audit)(\/|$)/, perm: "admin" },
  // Forms for things the role could not save anyway.
  { method: "GET", path: /^\/(templates|schedules)\/new$/, perm: "admin" },
  { method: "GET", path: /^\/hosts\/new$/, perm: "hosts" },
  { method: "POST", path: /^\/account(\/|$)/, perm: "read" },
  { method: "POST", path: /^\/templates\/\d+\/run$/, perm: "run" },
  { method: "POST", path: /^\/runs\/\d+\/cancel$/, perm: "run" },
  { method: "POST", path: /^\/schedules\/\d+\/trigger$/, perm: "run" },
  { method: "POST", path: /^\/hosts(\/|$)/, perm: "hosts" },
];

export function isRole(value: string): value is Role {
  return (ROLES as string[]).includes(value);
}

export function can(user: Pick<SessionUser, "role"> | null | undefined, perm: Permission): boolean {
  if (!user || !isRole(user.role)) return false;
  return RANK[user.role] >= RANK[MIN_ROLE[perm]];
}

export function permissionFor(method: string, path: string): Permission {
  const m = method === "HEAD" ? "GET" : method;
  for (const r of RULES) if (r.method === m && r.path.test(path)) return r.perm;
  return m === "GET" ? "read" : "admin";
}

export function enforceRoles(forbidden: (c: Context) => Response | Promise<Response>): MiddlewareHandler {
  return async (c, next) => {
    if (!can(c.get("user"), permissionFor(c.req.method, c.req.path))) return forbidden(c);
    await next();
  };
}
