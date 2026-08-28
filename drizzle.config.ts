import { defineConfig } from "drizzle-kit";

// Only `drizzle-kit generate` is used here (diffs schema.ts against the migrations
// folder to produce SQL files) — no live DB connection needed, so no driver/
// dbCredentials block. Migrations are applied to D1 via `wrangler d1 migrations apply`.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle/migrations",
});
