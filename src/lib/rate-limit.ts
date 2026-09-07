import { and, eq, lt } from "drizzle-orm";
import type { getDb } from "@/db/client";
import { rateLimits } from "@/db/schema";

const WINDOW_SECONDS = 15 * 60;

/**
 * Fixed-window counter: increments (or creates) a row for this key's current
 * 15-minute bucket, returns whether the caller is still under `limit`. Best
 * effort under concurrent requests (a race can let the count run one or two
 * over) — fine for brute-force throttling, not a correctness-critical count.
 */
export async function checkRateLimit(
  db: ReturnType<typeof getDb>,
  key: string,
  limit: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / WINDOW_SECONDS) * WINDOW_SECONDS;

  const [existing] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStart)))
    .limit(1);

  if (existing) {
    if (existing.count >= limit) {
      return { allowed: false, retryAfterSeconds: windowStart + WINDOW_SECONDS - now };
    }
    await db
      .update(rateLimits)
      .set({ count: existing.count + 1 })
      .where(and(eq(rateLimits.key, key), eq(rateLimits.windowStart, windowStart)));
  } else {
    await db.insert(rateLimits).values({ key, windowStart, count: 1 });
    // Best-effort cleanup of old windows for this key — keeps the table from
    // growing unbounded without needing a separate cron job.
    await db.delete(rateLimits).where(and(eq(rateLimits.key, key), lt(rateLimits.windowStart, windowStart)));
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/** Cloudflare always sets this on incoming requests — the real client IP. */
export function clientIp(req: Request): string {
  return req.headers.get("CF-Connecting-IP") ?? "unknown";
}
