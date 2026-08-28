import { Hono } from "hono";
import { HttpError } from "@/lib/http-error";
import { requireAdmin, requireAuth } from "@/middleware/auth";
import type { Env, Variables } from "@/types/env";

export const isbn = new Hono<{ Bindings: Env; Variables: Variables }>();

isbn.use("*", requireAuth, requireAdmin);

interface OpenLibraryEdition {
  title?: string;
  authors?: Array<{ key: string }>;
  works?: Array<{ key: string }>;
  publishers?: string[];
  number_of_pages?: number;
  publish_date?: string;
  languages?: Array<{ key: string }>;
}

/**
 * Looks up basic metadata for an ISBN from Open Library (free, no API key) to
 * prefill the admin "add book" form. Best-effort: if author/description/cover
 * sub-lookups fail, we still return whatever we got rather than erroring out —
 * the admin can fill in the gaps by hand.
 */
isbn.get("/:isbn", async (c) => {
  const rawIsbn = c.req.param("isbn").replace(/[^0-9Xx]/g, "");
  if (rawIsbn.length !== 10 && rawIsbn.length !== 13) {
    throw new HttpError(400, "ISBN must be 10 or 13 digits");
  }

  const editionRes = await fetch(`https://openlibrary.org/isbn/${rawIsbn}.json`, {
    headers: { "User-Agent": "bookish-bargains-hub-api/1.0" },
  });
  if (editionRes.status === 404) throw new HttpError(404, "No book found for that ISBN");
  if (!editionRes.ok) throw new HttpError(503, "Open Library lookup failed — try again or enter details manually");

  const edition = (await editionRes.json()) as OpenLibraryEdition;

  let author: string | null = null;
  const authorKey = edition.authors?.[0]?.key;
  if (authorKey) {
    try {
      const authorRes = await fetch(`https://openlibrary.org${authorKey}.json`);
      if (authorRes.ok) {
        const authorData = (await authorRes.json()) as { name?: string };
        author = authorData.name ?? null;
      }
    } catch {
      // best-effort — leave author null, admin fills it in
    }
  }

  let description: string | null = null;
  const workKey = edition.works?.[0]?.key;
  if (workKey) {
    try {
      const workRes = await fetch(`https://openlibrary.org${workKey}.json`);
      if (workRes.ok) {
        const workData = (await workRes.json()) as { description?: string | { value: string } };
        description = typeof workData.description === "string" ? workData.description : (workData.description?.value ?? null);
      }
    } catch {
      // best-effort
    }
  }

  return c.json({
    isbn: rawIsbn,
    title: edition.title ?? null,
    author,
    description,
    publisher: edition.publishers?.[0] ?? null,
    pages: edition.number_of_pages ?? null,
    publishedAt: edition.publish_date ?? null,
    // Open Library serves a placeholder-free 404 image if it has no cover for this
    // ISBN, so this URL is only a hint for the admin UI to preview — actually
    // storing it happens via POST /api/uploads/books/:id/cover/fetch, which
    // verifies the fetch actually returned image bytes before saving anything.
    coverUrl: `https://covers.openlibrary.org/b/isbn/${rawIsbn}-L.jpg`,
  });
});
