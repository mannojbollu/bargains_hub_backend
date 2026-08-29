import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role", { enum: ["customer", "admin"] })
    .notNull()
    .default("customer"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
}, (t) => ({
  emailIdx: uniqueIndex("users_email_idx").on(t.email),
}));

export const books = sqliteTable("books", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  author: text("author").notNull(),
  isbn: text("isbn").notNull(),
  category: text("category").notNull(),
  // JSON-encoded string[] — SQLite has no native array type.
  formats: text("formats", { mode: "json" }).notNull().$type<string[]>(),
  format: text("format").notNull(),
  price: real("price").notNull(),
  originalPrice: real("original_price").notNull(),
  rating: real("rating").notNull().default(0),
  reviewCount: integer("review_count").notNull().default(0),
  stock: text("stock", { enum: ["in_stock", "low_stock", "out_of_stock", "pre_order"] })
    .notNull()
    .default("in_stock"),
  // Real copy count, mainly kept in sync from the warehouse's marketplace push. `stock`
  // above is still the field the storefront renders from — this backs it for anything
  // that pushes an exact quantity instead of a status.
  stockQuantity: integer("stock_quantity").notNull().default(0),
  publisher: text("publisher").notNull(),
  pages: integer("pages").notNull(),
  language: text("language").notNull(),
  publishedAt: text("published_at").notNull(),
  description: text("description").notNull(),
  tags: text("tags", { mode: "json" }).notNull().$type<string[]>().default(sql`'[]'`),
  coverFrom: text("cover_from").notNull(),
  coverTo: text("cover_to").notNull(),
  // R2 object key for a real uploaded cover image. Null until one is uploaded,
  // in which case the frontend falls back to the coverFrom/coverTo gradient.
  coverImageKey: text("cover_image_key"),
  bestseller: integer("bestseller", { mode: "boolean" }).notNull().default(false),
  isNew: integer("is_new", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(current_timestamp)`),
}, (t) => ({
  slugIdx: uniqueIndex("books_slug_idx").on(t.slug),
  categoryIdx: index("books_category_idx").on(t.category),
}));

export const reviews = sqliteTable("reviews", {
  id: text("id").primaryKey(),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  rating: integer("rating").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
}, (t) => ({
  bookIdx: index("reviews_book_idx").on(t.bookId),
}));

export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  orderNumber: text("order_number").notNull(),
  // Checkout requires login, so every order belongs to a real user.
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "restrict" }),
  email: text("email").notNull(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  address: text("address").notNull(),
  city: text("city").notNull(),
  postcode: text("postcode").notNull(),
  country: text("country").notNull(),
  subtotal: real("subtotal").notNull(),
  discount: real("discount").notNull().default(0),
  shipping: real("shipping").notNull(),
  total: real("total").notNull(),
  couponCode: text("coupon_code"),
  status: text("status", { enum: ["pending", "paid", "fulfilled", "cancelled"] })
    .notNull()
    .default("pending"),
  // Set once a Checkout Session is created; the webhook uses it to find the
  // order to finalize. Payment is only ever confirmed server-side via the
  // signed Stripe webhook — never trust the client's post-payment redirect.
  stripeSessionId: text("stripe_session_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
}, (t) => ({
  orderNumberIdx: uniqueIndex("orders_order_number_idx").on(t.orderNumber),
  userIdx: index("orders_user_idx").on(t.userId),
  stripeSessionIdx: uniqueIndex("orders_stripe_session_idx").on(t.stripeSessionId),
}));

export const orderItems = sqliteTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "restrict" }),
  // Snapshots — order history must stay accurate even if the book's title/price
  // changes later.
  title: text("title").notNull(),
  price: real("price").notNull(),
  qty: integer("qty").notNull(),
  format: text("format").notNull(),
}, (t) => ({
  orderIdx: index("order_items_order_idx").on(t.orderId),
}));

export const wishlistItems = sqliteTable("wishlist_items", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  bookId: text("book_id")
    .notNull()
    .references(() => books.id, { onDelete: "cascade" }),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
}, (t) => ({
  userBookIdx: uniqueIndex("wishlist_user_book_idx").on(t.userId, t.bookId),
}));

export const coupons = sqliteTable("coupons", {
  code: text("code").primaryKey(),
  percentOff: integer("percent_off").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(current_timestamp)`),
});
