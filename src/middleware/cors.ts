import { cors } from "hono/cors";
import type { Env } from "@/types/env";

/**
 * Cross-origin API with cookie-based auth needs an exact origin echoed back
 * (never "*") plus credentials: true, or the browser silently drops the cookie.
 * FRONTEND_ORIGIN supports a comma-separated list for local dev + prod.
 */
export function corsMiddleware() {
  return cors({
    origin: (origin, c) => {
      const allowed = (c.env as Env).FRONTEND_ORIGIN.split(",").map((o) => o.trim());
      return origin && allowed.includes(origin) ? origin : allowed[0] ?? "";
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  });
}
