import { Hono } from "hono";
import type { Env, Variables } from "@/types/env";

export const health = new Hono<{ Bindings: Env; Variables: Variables }>();

health.get("/", (c) => c.json({ status: "ok", time: new Date().toISOString() }));
