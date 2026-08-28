import { Hono } from "hono";
import { like, or } from "drizzle-orm";
import { getDb } from "@/db/client";
import { books } from "@/db/schema";
import { searchSuggestQuerySchema } from "@/schemas/products.schema";
import type { Env, Variables } from "@/types/env";

export const search = new Hono<{ Bindings: Env; Variables: Variables }>();

search.get("/suggest", async (c) => {
  const { q } = searchSuggestQuerySchema.parse(c.req.query());
  const db = getDb(c.env.DB);
  const needle = `%${q}%`;
  const rows = await db
    .select()
    .from(books)
    .where(or(like(books.title, needle), like(books.author, needle)))
    .limit(6);
  return c.json(rows);
});
