/**
 * Generates scripts/seed.sql from the same book data the frontend's mock API
 * (src/lib/api/products.ts) used to ship, so the catalog looks identical on
 * cutover. Run via `npm run db:seed:local` / `db:seed:remote` (which generate
 * this file and then apply it with `wrangler d1 execute`).
 *
 * Deliberate difference from the old mock: there, `rating`/`reviewCount` were
 * synthetic flavour numbers unrelated to the tiny 2-review sample data. Here
 * they're the real, honest aggregate of the seeded reviews (avg rating, actual
 * count) — the same rule the API applies whenever a new review comes in, so
 * the numbers never drift out of sync with reality.
 */
import { writeFileSync } from "node:fs";
import bcrypt from "bcryptjs";

function esc(v: string): string {
  return v.replace(/'/g, "''");
}
function sqlStr(v: string): string {
  return `'${esc(v)}'`;
}
function sqlBool(v: boolean): string {
  return v ? "1" : "0";
}

const palettes: Array<[string, string]> = [
  ["#1f4735", "#3f7d5c"],
  ["#7a4a12", "#d69a3c"],
  ["#243a5e", "#4c74a8"],
  ["#5c1f2e", "#a8546a"],
  ["#2c3b1f", "#6f8b4a"],
  ["#3a2450", "#7c5da8"],
];

const raw: Array<{ title: string; author: string; category: string }> = [
  { title: "The Quiet Orchard", author: "Elena Marsh", category: "fiction" },
  { title: "Signals in the Static", author: "Tom Rayburn", category: "non-fiction" },
  { title: "Moonlit Cartography", author: "Priya Anand", category: "fiction" },
  { title: "The Winter Ledger", author: "Callum Reid", category: "crime-thriller" },
  { title: "Small Machines", author: "Nora Ellis", category: "non-fiction" },
  { title: "Bramble & Bee", author: "Jo Whitfield", category: "childrens" },
  { title: "Foundations of Modern Statistics", author: "R. K. Datta", category: "academic" },
  { title: "Salt, Smoke, Season", author: "Marco Bellini", category: "cooking" },
  { title: "The Lantern House", author: "Ada Fenwick", category: "fiction" },
  { title: "Nine Days in November", author: "Grant Okafor", category: "crime-thriller" },
  { title: "How Rivers Remember", author: "Sofia Lund", category: "non-fiction" },
  { title: "Pip and the Paper Moon", author: "Hana Sato", category: "childrens" },
  { title: "An Atlas of Small Hours", author: "Iris Delacroix", category: "fiction" },
  { title: "Organic Chemistry in Practice", author: "L. M. Fischer", category: "academic" },
  { title: "Weeknight Fire", author: "Dara Coyle", category: "cooking" },
  { title: "The Glasshouse Murders", author: "Ben Alderton", category: "crime-thriller" },
  { title: "Everything We Measure", author: "Yusuf Karim", category: "non-fiction" },
  { title: "The Boy Who Drew Storms", author: "Milly Grange", category: "childrens" },
];

const DESCRIPTION =
  "A brand-new copy at a fair price. This edition has been widely praised for its clarity, pace and warmth — a book that rewards a slow Sunday and stays with you long after the last page.";

const REVIEWER_NAMES = ["Sarah T.", "James P.", "Amelia R.", "Dev S.", "Priya M.", "Owen L.", "Kate D."];

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

interface Book {
  id: string;
  slug: string;
  title: string;
  author: string;
  isbn: string;
  category: string;
  formats: string[];
  format: string;
  price: number;
  originalPrice: number;
  publisher: string;
  pages: number;
  language: string;
  publishedAt: string;
  coverFrom: string;
  coverTo: string;
  bestseller: boolean;
  isNew: boolean;
}

const books: Book[] = raw.map((data, i) => {
  const [coverFrom, coverTo] = palettes[i % palettes.length]!;
  const originalPrice = Math.round((12.99 + ((i * 3.5) % 18)) * 100) / 100;
  const price = Math.round(originalPrice * (0.55 + (i % 4) * 0.08) * 100) / 100;
  return {
    id: String(i + 1),
    slug: slugify(data.title),
    title: data.title,
    author: data.author,
    category: data.category,
    isbn: `978-1-${400 + i}-${10000 + i * 7}-${i % 10}`,
    formats: i % 3 === 0 ? ["paperback", "hardback"] : ["paperback"],
    format: "paperback",
    originalPrice,
    price,
    publisher: ["Harbour Press", "Fernwood", "Ashgrove Books", "Northlight"][i % 4]!,
    pages: 208 + ((i * 29) % 400),
    language: "English",
    publishedAt: `202${3 + (i % 3)}-0${1 + (i % 9)}-1${i % 9}`,
    coverFrom,
    coverTo,
    bestseller: i % 5 === 0,
    isNew: i % 4 === 1,
  };
});

async function main() {
  const lines: string[] = [];

  // Demo reviewer accounts for the seed reviews below — unusable random
  // passwords, just here so `reviews.user_id` has a real account to point at.
  const reviewerIds = new Map<string, string>();
  for (const name of REVIEWER_NAMES) {
    const id = crypto.randomUUID();
    reviewerIds.set(name, id);
    const passwordHash = await bcrypt.hash(crypto.randomUUID(), 10);
    const email = `seed+${slugify(name)}@bookishbargains.invalid`;
    lines.push(
      `INSERT INTO users (id, email, password_hash, name, role) VALUES (${sqlStr(id)}, ${sqlStr(email)}, ${sqlStr(passwordHash)}, ${sqlStr(name)}, 'customer');`,
    );
  }

  lines.push(`INSERT INTO coupons (code, percent_off, active) VALUES ('READMORE10', 10, 1);`);
  lines.push(`INSERT INTO coupons (code, percent_off, active) VALUES ('SHELFIE15', 15, 1);`);

  books.forEach((b, i) => {
    const stock = ["in_stock", "in_stock", "low_stock", "in_stock", "pre_order", "out_of_stock"][i % 6]!;

    const reviewerA = REVIEWER_NAMES[i % 4]!;
    const reviewerB = REVIEWER_NAMES[4 + (i % 3)]!;
    const reviews = [
      { reviewer: reviewerA, rating: 5, title: "Arrived quickly, perfect condition", body: "Brand new as described and cheaper than anywhere else I looked. Will order again." },
      { reviewer: reviewerB, rating: 4, title: "Great read", body: "Took a couple of chapters to get going but well worth sticking with." },
    ];
    const avgRating = Math.round(((reviews[0]!.rating + reviews[1]!.rating) / 2) * 10) / 10;

    lines.push(
      `INSERT INTO books (id, slug, title, author, isbn, category, formats, format, price, original_price, rating, review_count, stock, publisher, pages, language, published_at, description, tags, cover_from, cover_to, bestseller, is_new) VALUES (` +
        [
          sqlStr(b.id),
          sqlStr(b.slug),
          sqlStr(b.title),
          sqlStr(b.author),
          sqlStr(b.isbn),
          sqlStr(b.category),
          sqlStr(JSON.stringify(b.formats)),
          sqlStr(b.format),
          b.price,
          b.originalPrice,
          avgRating,
          reviews.length,
          sqlStr(stock),
          sqlStr(b.publisher),
          b.pages,
          sqlStr(b.language),
          sqlStr(b.publishedAt),
          sqlStr(DESCRIPTION),
          sqlStr("[]"),
          sqlStr(b.coverFrom),
          sqlStr(b.coverTo),
          sqlBool(b.bestseller),
          sqlBool(b.isNew),
        ].join(", ") +
        `);`,
    );

    for (const r of reviews) {
      lines.push(
        `INSERT INTO reviews (id, book_id, user_id, rating, title, body) VALUES (${sqlStr(crypto.randomUUID())}, ${sqlStr(b.id)}, ${sqlStr(reviewerIds.get(r.reviewer)!)}, ${r.rating}, ${sqlStr(r.title)}, ${sqlStr(r.body)});`,
      );
    }
  });

  writeFileSync(new URL("./seed.sql", import.meta.url), lines.join("\n") + "\n");
  console.log(`Wrote scripts/seed.sql (${books.length} books, ${REVIEWER_NAMES.length} demo reviewers, ${books.length * 2} reviews)`);
}

main();
