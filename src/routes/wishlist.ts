import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { books, wishlistItems } from "@/db/schema";
import { newId } from "@/lib/ids";
import { requireAuth } from "@/middleware/auth";
import type { Env, Variables } from "@/types/env";

export const wishlist = new Hono<{ Bindings: Env; Variables: Variables }>();

wishlist.use("*", requireAuth);

wishlist.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get("user")!;
  const rows = await db
    .select({ book: books })
    .from(wishlistItems)
    .innerJoin(books, eq(books.id, wishlistItems.bookId))
    .where(eq(wishlistItems.userId, user.id));
  return c.json(rows.map((r) => r.book));
});

wishlist.post("/:bookId", async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get("user")!;
  const bookId = c.req.param("bookId");

  const [existing] = await db
    .select({ id: wishlistItems.id })
    .from(wishlistItems)
    .where(and(eq(wishlistItems.userId, user.id), eq(wishlistItems.bookId, bookId)))
    .limit(1);
  if (!existing) {
    await db.insert(wishlistItems).values({ id: newId(), userId: user.id, bookId });
  }
  return c.json({ ok: true }, 201);
});

wishlist.delete("/:bookId", async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get("user")!;
  await db
    .delete(wishlistItems)
    .where(and(eq(wishlistItems.userId, user.id), eq(wishlistItems.bookId, c.req.param("bookId"))));
  return c.json({ ok: true });
});
