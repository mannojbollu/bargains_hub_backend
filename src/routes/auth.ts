import { Hono, type Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { users } from "@/db/schema";
import { signupSchema, loginSchema } from "@/schemas/auth.schema";
import { hashPassword, verifyPassword } from "@/lib/password";
import { signSession } from "@/lib/jwt";
import { newId } from "@/lib/ids";
import { HttpError } from "@/lib/http-error";
import { SESSION_COOKIE, requireAuth } from "@/middleware/auth";
import type { AuthUser, Env, Variables } from "@/types/env";

export const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

const SEVEN_DAYS = 60 * 60 * 24 * 7;

async function issueSession(c: Context<{ Bindings: Env; Variables: Variables }>, user: AuthUser) {
  const token = await signSession(user, c.env.JWT_SECRET);
  // `wrangler dev` serves over plain http:// locally — a Secure cookie is silently
  // dropped by the browser there, and SameSite=None is rejected without Secure. So
  // this mirrors the request's own protocol rather than hardcoding either.
  const isHttps = new URL(c.req.url).protocol === "https:";
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? "None" : "Lax",
    path: "/",
    maxAge: SEVEN_DAYS,
  });
}

auth.post("/signup", async (c) => {
  const body = signupSchema.parse(await c.req.json());
  const db = getDb(c.env.DB);

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
  if (existing) throw new HttpError(409, "An account with this email already exists");

  const id = newId();
  const passwordHash = await hashPassword(body.password);
  await db.insert(users).values({ id, email: body.email, passwordHash, name: body.name, role: "customer" });

  const user: AuthUser = { id, email: body.email, name: body.name, role: "customer" };
  await issueSession(c, user);
  return c.json({ user }, 201);
});

auth.post("/login", async (c) => {
  const body = loginSchema.parse(await c.req.json());
  const db = getDb(c.env.DB);

  const [row] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
  if (!row || !(await verifyPassword(body.password, row.passwordHash))) {
    throw new HttpError(401, "Invalid email or password");
  }

  const user: AuthUser = { id: row.id, email: row.email, name: row.name, role: row.role };
  await issueSession(c, user);
  return c.json({ user });
});

auth.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

auth.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));
