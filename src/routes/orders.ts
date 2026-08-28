import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { books, coupons, orderItems, orders } from "@/db/schema";
import { createOrderSchema } from "@/schemas/orders.schema";
import { newId, newOrderNumber } from "@/lib/ids";
import { HttpError } from "@/lib/http-error";
import { requireAuth } from "@/middleware/auth";
import type { Env, Variables } from "@/types/env";

export const ordersRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

const FREE_SHIPPING_THRESHOLD = 25;
const SHIPPING_FLAT = 2.99;

// Checkout requires login (see auth middleware below) — every order is tied to a
// real account, so there's no guest-order path here.
ordersRoute.use("*", requireAuth);

ordersRoute.post("/", async (c) => {
  const body = createOrderSchema.parse(await c.req.json());
  const db = getDb(c.env.DB);
  const user = c.get("user")!;

  const bookIds = [...new Set(body.lines.map((l) => l.bookId))];
  const rows = await db.select().from(books).where(inArray(books.id, bookIds));
  const byId = new Map(rows.map((b) => [b.id, b]));

  for (const line of body.lines) {
    const book = byId.get(line.bookId);
    if (!book) throw new HttpError(400, `Unknown book: ${line.bookId}`);
    if (book.stock === "out_of_stock") throw new HttpError(409, `${book.title} is out of stock`);
  }

  // Prices are never trusted from the client — always re-derived from `books`.
  const subtotal = body.lines.reduce((sum, l) => sum + byId.get(l.bookId)!.price * l.qty, 0);

  let discount = 0;
  let couponCode: string | null = null;
  if (body.couponCode) {
    const [coupon] = await db
      .select()
      .from(coupons)
      .where(and(eq(coupons.code, body.couponCode.toUpperCase()), eq(coupons.active, true)))
      .limit(1);
    if (!coupon) throw new HttpError(400, "Invalid or expired coupon code");
    discount = Math.round(subtotal * coupon.percentOff) / 100;
    couponCode = coupon.code;
  }

  const net = subtotal - discount;
  const shipping = net >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT;
  const total = net + shipping;

  const orderId = newId();
  const orderNumber = newOrderNumber();

  await db.insert(orders).values({
    id: orderId,
    orderNumber,
    userId: user.id,
    email: body.email,
    firstName: body.firstName,
    lastName: body.lastName,
    address: body.address,
    city: body.city,
    postcode: body.postcode,
    country: body.country,
    subtotal,
    discount,
    shipping,
    total,
    couponCode,
    status: "paid",
  });

  await db.insert(orderItems).values(
    body.lines.map((l) => {
      const book = byId.get(l.bookId)!;
      return {
        id: newId(),
        orderId,
        bookId: book.id,
        title: book.title,
        price: book.price,
        qty: l.qty,
        format: l.format,
      };
    }),
  );

  return c.json({ orderNumber, subtotal, discount, shipping, total }, 201);
});

ordersRoute.get("/", async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get("user")!;
  const rows = await db
    .select()
    .from(orders)
    .where(eq(orders.userId, user.id))
    .orderBy(desc(orders.createdAt));
  return c.json(rows);
});

ordersRoute.get("/:orderNumber", async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get("user")!;
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.orderNumber, c.req.param("orderNumber")), eq(orders.userId, user.id)))
    .limit(1);
  if (!order) throw new HttpError(404, "Order not found");

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  return c.json({ ...order, items });
});
