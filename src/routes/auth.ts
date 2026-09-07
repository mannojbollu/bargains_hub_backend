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
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { SESSION_COOKIE, requireAuth } from "@/middleware/auth";
import type { AuthUser, Env, Variables } from "@/types/env";

export const auth = new Hono<{ Bindings: Env; Variables: Variables }>();

const SEVEN_DAYS = 60 * 60 * 24 * 7;

// Never matches a real password — only exists so a login attempt for a
// non-existent email still pays the same bcrypt cost as one for a real
// account. Without this, response timing alone reveals which emails have
// accounts (fast rejection vs. slow bcrypt compare).
const DUMMY_HASH_FOR_TIMING = "$2a$10$7jB2xUz9ngNPaIe5yR0RmOfirpOfk6NEfuY35DGE7Kp3ABQD7B27a";

async function issueSession(c: Context<{ Bindings: Env; Variables: Variables }>, userId: string) {
  const token = await signSession(userId, c.env.JWT_SECRET);
  // The frontend (bargainnewbooks.com) and this API (api.bargainnewbooks.com)
  // are different origins but the same site (same registrable domain), so Lax
  // is enough — and far more reliably honoured by mobile browsers than
  // SameSite=None, which several (mobile Safari especially) restrict or drop
  // for genuinely cross-site cookies. Also correct for local dev, where both
  // sides are "localhost" on different ports — same-site by that same rule.
  const isHttps = new URL(c.req.url).protocol === "https:";
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: "Lax",
    path: "/",
    maxAge: SEVEN_DAYS,
  });
}

auth.post("/signup", async (c) => {
  const db = getDb(c.env.DB);
  // 5 signups per IP per 15 min — generous for a real user, tight enough to
  // blunt automated account-creation spam.
  const rate = await checkRateLimit(db, `${clientIp(c.req.raw)}:signup`, 5);
  if (!rate.allowed) throw new HttpError(429, `Too many attempts — try again in a few minutes`);

  const body = signupSchema.parse(await c.req.json());

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, body.email)).limit(1);
  if (existing) throw new HttpError(409, "An account with this email already exists");

  const id = newId();
  const passwordHash = await hashPassword(body.password);
  await db.insert(users).values({ id, email: body.email, passwordHash, name: body.name, role: "customer" });

  const user: AuthUser = { id, email: body.email, name: body.name, role: "customer" };
  await issueSession(c, id);
  return c.json({ user }, 201);
});

auth.post("/login", async (c) => {
  const db = getDb(c.env.DB);
  const body = loginSchema.parse(await c.req.json());

  // Two independent limits: by IP (stops one machine hammering any account)
  // and by the email being attempted (stops credential-stuffing one account
  // from many IPs). Either tripping blocks the request.
  const ipRate = await checkRateLimit(db, `${clientIp(c.req.raw)}:login`, 20);
  const emailRate = await checkRateLimit(db, `login-email:${body.email.toLowerCase()}`, 10);
  if (!ipRate.allowed || !emailRate.allowed) {
    throw new HttpError(429, "Too many attempts — try again in a few minutes");
  }

  const [row] = await db.select().from(users).where(eq(users.email, body.email)).limit(1);
  // Always run the bcrypt compare, even when no such user exists, against a
  // fixed dummy hash — see DUMMY_HASH_FOR_TIMING above.
  const passwordOk = await verifyPassword(body.password, row?.passwordHash ?? DUMMY_HASH_FOR_TIMING);
  if (!row || !passwordOk) {
    throw new HttpError(401, "Invalid email or password");
  }

  const user: AuthUser = { id: row.id, email: row.email, name: row.name, role: row.role };
  await issueSession(c, row.id);
  return c.json({ user });
});

auth.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

auth.get("/me", requireAuth, (c) => c.json({ user: c.get("user") }));
