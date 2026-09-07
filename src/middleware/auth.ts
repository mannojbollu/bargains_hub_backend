import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { verifySessionUserId } from "@/lib/jwt";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import type { AuthUser, Env, Variables } from "@/types/env";

export const SESSION_COOKIE = "bnb_session";

/**
 * Reads the session cookie (if any) and attaches the user to context — never
 * throws. The JWT only proves identity (a user id); role is always re-read
 * fresh from the database here rather than trusted from the token, so a role
 * change or account deletion takes effect on the very next request instead of
 * only once a stale session naturally expires.
 */
export const attachUser = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const userId = token ? await verifySessionUserId(token, c.env.JWT_SECRET) : null;

  let user: AuthUser | null = null;
  if (userId) {
    const db = getDb(c.env.DB);
    const [row] = await db
      .select({ id: users.id, email: users.email, name: users.name, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (row) user = row;
  }

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

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Admin routes the warehouse's sync job also needs to call server-to-server, with
 * no browser session available. A matching `X-Api-Key` header skips the cookie/role
 * check entirely; otherwise this falls back to the normal admin login flow.
 */
export const requireAdminOrApiKey = createMiddleware<{ Bindings: Env; Variables: Variables }>(async (c, next) => {
  const apiKey = c.req.header("X-Api-Key");
  if (apiKey && timingSafeEqual(apiKey, c.env.WAREHOUSE_API_KEY)) {
    await next();
    return;
  }
  const user = c.get("user");
  if (!user) throw new HttpError(401, "Login required");
  if (user.role !== "admin") throw new HttpError(403, "Admin access required");
  await next();
});
