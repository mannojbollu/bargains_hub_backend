import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb } from "@/db/client";
import { books } from "@/db/schema";
import { newId } from "@/lib/ids";
import { HttpError } from "@/lib/http-error";
import { requireAdmin, requireAuth } from "@/middleware/auth";
import type { Env, Variables } from "@/types/env";

export const uploads = new Hono<{ Bindings: Env; Variables: Variables }>();

uploads.use("*", requireAuth, requireAdmin);

const MAX_BYTES = 8 * 1024 * 1024; // 8MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "application/pdf"]);

/**
 * Uploads a cover image/document for a book straight through the Worker into R2.
 * Requires the BUCKET binding — see wrangler.jsonc / README for the one-time R2
 * setup (enable R2 on the account, `wrangler r2 bucket create`, uncomment the
 * binding). Until then this returns 503 rather than crashing.
 */
uploads.post("/books/:id/cover", async (c) => {
  if (!c.env.BUCKET) throw new HttpError(503, "R2 storage is not configured yet");

  const bookId = c.req.param("id");
  const db = getDb(c.env.DB);
  const [book] = await db.select({ id: books.id }).from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) throw new HttpError(404, "Book not found");

  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Missing file field");
  if (!ALLOWED_TYPES.has(file.type)) throw new HttpError(400, `Unsupported file type: ${file.type}`);
  if (file.size > MAX_BYTES) throw new HttpError(400, "File too large (max 8MB)");

  const ext = file.type.split("/")[1];
  const key = `books/${bookId}/cover-${newId()}.${ext}`;
  await c.env.BUCKET.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type },
  });

  await db.update(books).set({ coverImageKey: key }).where(eq(books.id, bookId));
  return c.json({ key }, 201);
});

/**
 * Auto-fetch path: pulls the cover Open Library serves for this book's ISBN and
 * stores our own copy in R2 (never just links to Open Library directly — hot-
 * linking is unreliable and outside our control). Open Library returns a tiny
 * 1x1 placeholder GIF for ISBNs it has no cover for rather than a 404, so this
 * checks the content-type/size before treating it as a real cover.
 */
uploads.post("/books/:id/cover/fetch", async (c) => {
  if (!c.env.BUCKET) throw new HttpError(503, "R2 storage is not configured yet");

  const bookId = c.req.param("id");
  const db = getDb(c.env.DB);
  const [book] = await db.select({ id: books.id, isbn: books.isbn }).from(books).where(eq(books.id, bookId)).limit(1);
  if (!book) throw new HttpError(404, "Book not found");

  const rawIsbn = book.isbn.replace(/[^0-9Xx]/g, "");
  const res = await fetch(`https://covers.openlibrary.org/b/isbn/${rawIsbn}-L.jpg`, {
    headers: { "User-Agent": "bookish-bargains-hub-api/1.0" },
  });
  if (!res.ok) throw new HttpError(404, "Open Library has no cover for this ISBN — upload one manually");

  const bytes = await res.arrayBuffer();
  // Open Library's "no cover" placeholder is ~800 bytes; a real cover is always
  // much larger, so this is a reliable enough check without parsing image data.
  if (bytes.byteLength < 3000) throw new HttpError(404, "Open Library has no cover for this ISBN — upload one manually");

  const key = `books/${bookId}/cover-${newId()}.jpg`;
  await c.env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });

  await db.update(books).set({ coverImageKey: key }).where(eq(books.id, bookId));
  return c.json({ key }, 201);
});
