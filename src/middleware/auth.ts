import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { verifySession } from "@/lib/jwt";
import { HttpError } from "@/lib/http-error";
import type { Env, Variables } from "@/types/env";

export const SESSION_COOKIE = "bnb_session";

/** Reads the session cookie (if any) and attaches the user to context — never throws. */
export const attachUser = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await verifySession(token, c.env.JWT_SECRET) : null;
  c.set("user", user);
  await next();
});

/** Use after attachUser on routes that require a logged-in user. */
export const requireAuth = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  if (!c.get("user")) throw new HttpError(401, "Login required");
  await next();
});

/** Use after requireAuth on admin-only routes (e.g. cover image uploads). */
export const requireAdmin = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  if (c.get("user")?.role !== "admin") throw new HttpError(403, "Admin access required");
  await next();
});
