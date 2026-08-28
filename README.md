# bookish-bargains-hub-api

Backend for the BargainNewBooks storefront (`../bookish-bargains-hub`). A Cloudflare
Worker (Hono) backed by D1 (SQLite) and R2, deployed completely separately from the
frontend.

## Stack

- **Runtime:** Cloudflare Workers
- **Framework:** [Hono](https://hono.dev)
- **Database:** Cloudflare D1 via [Drizzle ORM](https://orm.drizzle.team)
- **Storage:** Cloudflare R2 (book cover images / documents)
- **Auth:** JWT in an httpOnly cookie, passwords hashed with bcryptjs. **Checkout
  requires login** — browsing/search/reviews are public, but `POST /api/orders` is
  auth-gated (no guest checkout).

## One-time setup

```bash
npm install
cp .dev.vars.example .dev.vars   # then set JWT_SECRET to a long random string
```

The D1 database (`bookish-bargains-hub-db`) is already created and wired into
`wrangler.jsonc`. Apply the schema locally:

```bash
npm run db:migrate:local
```

The catalog starts **empty** — this is a real inventory, not demo data. Sign up
an account through the frontend, then promote it to admin so you can add books:

```bash
npx wrangler d1 execute DB --local --command "UPDATE users SET role='admin' WHERE email='you@example.com';"
# --remote instead of --local once deployed
```

From there, `/admin/books` on the frontend lets you add real books by ISBN
(auto-fills title/author/publisher/pages/description from Open Library) and
manage the catalog.

If you want the old fictional demo catalog instead (useful for quick UI
testing), `npm run db:seed:local` loads the same 18 books/reviews the frontend
used to mock, and `npm run db:clear-demo:local` removes them again.

Then start the dev server:

```bash
npm run dev   # http://localhost:8787
```

### R2 (cover image uploads) — not yet enabled

R2 isn't turned on for this Cloudflare account yet. Uploads (`POST
/api/uploads/books/:id/cover`) return `503` until it is. To enable:

1. Enable R2 in the Cloudflare dashboard (Storage & Databases → R2) — this is a
   one-time account-level opt-in only doable from the dashboard.
2. `npx wrangler r2 bucket create bookish-bargains-hub-assets`
3. Uncomment the `r2_buckets` block in `wrangler.jsonc`.

Everything else works without this — it only affects the admin cover-upload endpoint.

## Deploying

```bash
npx wrangler secret put JWT_SECRET   # once, for the deployed Worker
npm run db:migrate:remote
npm run db:seed:remote               # only on first deploy — seeds the catalog
npm run deploy
```

Update `FRONTEND_ORIGIN` in `wrangler.jsonc` to the frontend's deployed URL (comma-
separated if you need more than one, e.g. a preview + production domain) before
deploying.

## API

All routes are under `/api`. See `src/routes/*.ts` for the full implementation.

| Route | Auth | Notes |
|---|---|---|
| `GET /api/health` | — | |
| `GET /api/products` | — | filters: category, q, formats, minPrice, maxPrice, minRating, inStockOnly, bestseller, isNew, sort (incl. `deals`), page, perPage |
| `POST /api/products` | admin | create a book |
| `PATCH /api/products/:id` | admin | partial update |
| `DELETE /api/products/:id` | admin | blocked (409) if the book appears in an existing order |
| `GET /api/products/:slug` | — | |
| `GET /api/products/:id/reviews` | — | |
| `POST /api/products/:id/reviews` | login | recomputes the book's `rating`/`reviewCount` |
| `GET /api/products/:id/related` | — | |
| `GET /api/search/suggest?q=` | — | |
| `GET /api/isbn/:isbn` | admin | Open Library lookup, best-effort — used to prefill the admin add-book form |
| `POST /api/auth/signup` | — | sets the session cookie |
| `POST /api/auth/login` | — | |
| `POST /api/auth/logout` | — | |
| `GET /api/auth/me` | login | |
| `POST /api/orders` | **login required** | server re-prices every line from `books`, never trusts client-sent prices |
| `GET /api/orders` | login | current user's order history |
| `GET /api/orders/:orderNumber` | login | must belong to the current user |
| `GET/POST/DELETE /api/wishlist[/:bookId]` | login | |
| `POST /api/uploads/books/:id/cover` | admin | manual image upload, needs R2 (see above) |
| `POST /api/uploads/books/:id/cover/fetch` | admin | auto-fetches the book's cover from Open Library by ISBN and stores it in R2 |
| `GET /api/images/:key` | — | streams a stored cover image from R2, public |

## Design notes / deliberate differences from the old frontend mock

- **`rating` / `reviewCount` are always real**, derived from actual rows in
  `reviews` (recomputed on every new review) — not the synthetic flavour numbers
  the old mock used. The seed data reflects this (all books start at the same
  4.5★/2 reviews from the 2 seeded demo reviews) rather than the mock's varied-
  looking but fake numbers.
- **No payment fields are accepted or stored.** There's no real payment gateway
  wired up, so `POST /api/orders` only takes contact/shipping details + cart
  lines — never card data, mock or otherwise.
- **Coupons live server-side** (`coupons` table) and are validated at checkout,
  rather than the hardcoded client-side list the mock had.

## Frontend integration

Done — the frontend (`../bookish-bargains-hub`) talks to this backend for real:
catalog browsing, auth (sign in/up gates checkout), orders, wishlist, and the
`/admin/books` inventory management page (ISBN lookup, cover upload/auto-fetch,
edit/delete), all live-tested end to end.

`VITE_API_BASE_URL` in the frontend's `.env.local` points at this Worker
(`http://localhost:8787/api` locally). For local dev, `localhost:8080` and
`localhost:8787` are different origins but the *same site* (SameSite cookie
policy is scoped to registrable domain, not port) — so the session cookie
works cross-port with no proxy needed. In production, once the frontend and
this Worker are on genuinely different domains, both sides being HTTPS makes
`SameSite=None; Secure` (see `src/routes/auth.ts`) work the same way.

Not wired up on the frontend yet, if you want them later: a UI for customers
to submit reviews (the `POST /api/products/:id/reviews` endpoint exists,
nothing calls it), and admin-only visibility for order status changes.
