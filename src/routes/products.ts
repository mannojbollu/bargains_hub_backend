import { Hono } from "hono";
import { and, desc, eq, gte, like, lte, or, sql } from "drizzle-orm";
import { getDb } from "@/db/client";
import { books, reviews, users } from "@/db/schema";
import { productQuerySchema, createReviewSchema, createBookSchema, updateBookSchema } from "@/schemas/products.schema";
import { paginate } from "@/lib/pagination";
import { newId } from "@/lib/ids";
import { slugify, uniqueSlug } from "@/lib/slug";
import { HttpError } from "@/lib/http-error";
import { requireAdmin, requireAdminOrApiKey, requireAuth } from "@/middleware/auth";
import type { Env, Variables } from "@/types/env";

export const products = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEFAULT_PER_PAGE = 12;

// Whenever a caller supplies an exact stockQuantity (the warehouse push, mainly),
// `stock` is derived from it server-side rather than trusted separately, so the
// two fields can't drift out of sync with each other.
function deriveStockFromQuantity(quantity: number): "in_stock" | "low_stock" | "out_of_stock" {
  if (quantity <= 0) return "out_of_stock";
  if (quantity <= 2) return "low_stock";
  return "in_stock";
}

products.get("/", async (c) => {
  const query = productQuerySchema.parse(c.req.query());
  const db = getDb(c.env.DB);

  const conditions = [];
  if (query.category) conditions.push(eq(books.category, query.category));
  if (query.q) {
    const needle = `%${query.q}%`;
    conditions.push(or(like(books.title, needle), like(books.author, needle), like(books.isbn, needle)));
  }
  if (query.minPrice !== undefined) conditions.push(gte(books.price, query.minPrice));
  if (query.maxPrice !== undefined) conditions.push(lte(books.price, query.maxPrice));
  if (query.minRating !== undefined) conditions.push(gte(books.rating, query.minRating));
  if (query.inStockOnly) conditions.push(sql`${books.stock} != 'out_of_stock'`);
  if (query.bestseller) conditions.push(eq(books.bestseller, true));
  if (query.isNew) conditions.push(eq(books.isNew, true));

  let rows = await db
    .select()
    .from(books)
    .where(conditions.length ? and(...conditions) : undefined);

  // Formats is JSON-encoded, so "any of the requested formats" is filtered in JS —
  // the catalog is small enough that this is simpler and just as fast as a
  // json_each SQL join.
  if (query.formats?.length) {
    rows = rows.filter((b) => query.formats!.some((f) => b.formats.includes(f)));
  }

  switch (query.sort) {
    case "price-asc":
      rows.sort((a, b) => a.price - b.price);
      break;
    case "price-desc":
      rows.sort((a, b) => b.price - a.price);
      break;
    case "newest":
      rows.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
      break;
    case "rating":
      rows.sort((a, b) => b.rating - a.rating);
      break;
    case "bestselling":
      rows.sort((a, b) => Number(b.bestseller) - Number(a.bestseller) || b.reviewCount - a.reviewCount);
      break;
    case "deals":
      rows.sort((a, b) => a.price / a.originalPrice - b.price / b.originalPrice);
      break;
    default:
      break;
  }

  const perPage = query.perPage ?? DEFAULT_PER_PAGE;
  const page = query.page ?? 1;
  const start = (page - 1) * perPage;
  const items = rows.slice(start, start + perPage);

  return c.json(paginate(items, rows.length, page, perPage));
});

products.post("/", requireAdminOrApiKey, async (c) => {
  const body = createBookSchema.parse(await c.req.json());
  const db = getDb(c.env.DB);

  const existingSlugs = await db.select({ slug: books.slug }).from(books);
  const slug = uniqueSlug(body.title, new Set(existingSlugs.map((s) => s.slug)));

  const id = newId();
  const stock = body.stockQuantity !== undefined ? deriveStockFromQuantity(body.stockQuantity) : body.stock;
  await db.insert(books).values({ id, slug, rating: 0, reviewCount: 0, ...body, stock });

  const [created] = await db.select().from(books).where(eq(books.id, id)).limit(1);
  return c.json(created, 201);
});

products.patch("/:id", requireAdminOrApiKey, async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const [existing] = await db.select({ id: books.id }).from(books).where(eq(books.id, id)).limit(1);
  if (!existing) throw new HttpError(404, "Book not found");

  const body = updateBookSchema.parse(await c.req.json());
  const stock = body.stockQuantity !== undefined ? deriveStockFromQuantity(body.stockQuantity) : body.stock;
  await db
    .update(books)
    .set({ ...body, ...(stock !== undefined ? { stock } : {}), updatedAt: sql`(current_timestamp)` })
    .where(eq(books.id, id));

  const [updated] = await db.select().from(books).where(eq(books.id, id)).limit(1);
  return c.json(updated);
});

products.delete("/:id", requireAuth, requireAdmin, async (c) => {
  const id = c.req.param("id");
  const db = getDb(c.env.DB);
  const [existing] = await db.select({ id: books.id }).from(books).where(eq(books.id, id)).limit(1);
  if (!existing) throw new HttpError(404, "Book not found");

  try {
    await db.delete(books).where(eq(books.id, id));
  } catch (err) {
    if (err instanceof Error && err.message.includes("FOREIGN KEY constraint failed")) {
      throw new HttpError(409, "Can't delete a book that appears in existing orders — mark it out of stock instead");
    }
    throw err;
  }
  return c.json({ ok: true });
});

products.get("/:slug", async (c) => {
  const db = getDb(c.env.DB);
  const [book] = await db.select().from(books).where(eq(books.slug, c.req.param("slug"))).limit(1);
  if (!book) throw new HttpError(404, "Book not found");
  return c.json(book);
});

products.get("/:id/reviews", async (c) => {
  const db = getDb(c.env.DB);
  const rows = await db
    .select({
      id: reviews.id,
      bookId: reviews.bookId,
      rating: reviews.rating,
      title: reviews.title,
      body: reviews.body,
      createdAt: reviews.createdAt,
      reviewerName: users.name,
    })
    .from(reviews)
    .innerJoin(users, eq(users.id, reviews.userId))
    .where(eq(reviews.bookId, c.req.param("id")))
    .orderBy(desc(reviews.createdAt));
  return c.json(rows);
});

products.post("/:id/reviews", requireAuth, async (c) => {
  const bookId = c.req.param("id");
  const db = getDb(c.env.DB);
  const [book] = await db.select({ id: books.id }).from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) throw new HttpError(404, "Book not found");

  const body = createReviewSchema.parse(await c.req.json());
  const user = c.get("user")!;

  const id = newId();
  await db.insert(reviews).values({ id, bookId, userId: user.id, ...body });

  const [agg] = await db
    .select({ count: sql<number>`count(*)`, avg: sql<number>`avg(${reviews.rating})` })
    .from(reviews)
    .where(eq(reviews.bookId, bookId));
  const count = agg?.count ?? 0;
  const avg = agg?.avg ?? 0;
  await db
    .update(books)
    .set({ reviewCount: count, rating: Math.round(avg * 10) / 10 })
    .where(eq(books.id, bookId));

  return c.json({ id }, 201);
});

products.get("/:id/related", async (c) => {
  const db = getDb(c.env.DB);
  const [book] = await db.select().from(books).where(eq(books.id, c.req.param("id"))).limit(1);
  if (!book) throw new HttpError(404, "Book not found");

  const rows = await db
    .select()
    .from(books)
    .where(and(eq(books.category, book.category), sql`${books.id} != ${book.id}`))
    .limit(6);
  return c.json(rows);
});
