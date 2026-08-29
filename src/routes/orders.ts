import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { orderItems, orders } from "@/db/schema";
import { createOrderSchema } from "@/schemas/orders.schema";
import { newId, newOrderNumber } from "@/lib/ids";
import { HttpError } from "@/lib/http-error";
import { priceLines } from "@/lib/pricing";
import { getStripe } from "@/lib/stripe";
import { requireAdmin, requireAuth } from "@/middleware/auth";
import type { Env, Variables } from "@/types/env";

export const ordersRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

// Checkout requires login (see auth middleware below) — every order is tied to a
// real account, so there's no guest-order path here.
ordersRoute.use("*", requireAuth);

function resolveFrontendOrigin(c: { req: { header: (name: string) => string | undefined }; env: Env }) {
  const allowed = c.env.FRONTEND_ORIGIN.split(",").map((o) => o.trim());
  const origin = c.req.header("Origin");
  return origin && allowed.includes(origin) ? origin : (allowed[0] ?? "");
}

ordersRoute.post("/", async (c) => {
  const body = createOrderSchema.parse(await c.req.json());
  const db = getDb(c.env.DB);
  const user = c.get("user")!;

  const { byId, subtotal, discount, couponCode, shipping, total } = await priceLines(
    db,
    body.lines,
    body.couponCode,
  );

  const orderId = newId();
  const orderNumber = newOrderNumber();

  // Order is created as "pending" — it only becomes "paid" once the Stripe
  // webhook confirms payment server-to-server. Nothing the client sends after
  // this point can mark an order paid.
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
    status: "pending",
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

  const frontendOrigin = resolveFrontendOrigin(c);
  const stripe = getStripe(c.env.STRIPE_SECRET_KEY);

  try {
    // A single line item priced at our server-computed total — the source of
    // truth for the charge amount is always our own pricing, never anything
    // client-supplied or re-derived from Stripe's side.
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: body.email,
      client_reference_id: orderId,
      line_items: [
        {
          price_data: {
            currency: "gbp",
            product_data: { name: `BargainNewBooks order ${orderNumber}` },
            unit_amount: Math.round(total * 100),
          },
          quantity: 1,
        },
      ],
      success_url: `${frontendOrigin}/order/${orderNumber}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendOrigin}/checkout?cancelled=1`,
      metadata: { orderId, orderNumber, userId: user.id },
    });

    await db.update(orders).set({ stripeSessionId: session.id }).where(eq(orders.id, orderId));

    return c.json({ orderNumber, total, checkoutUrl: session.url }, 201);
  } catch (err) {
    // Payment session couldn't be created — don't leave a dangling pending order.
    await db.delete(orders).where(eq(orders.id, orderId));
    console.error("Stripe checkout session creation failed", err);
    throw new HttpError(503, "Could not start payment — please try again");
  }
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

// Admin-only: every order across every customer, with shipping details and line
// items, so the admin can see what was bought and fulfill it manually. Registered
// before the "/:orderNumber" param route below so "/admin" doesn't get swallowed
// by it.
const ORDER_STATUSES = ["pending", "paid", "fulfilled", "cancelled"] as const;

ordersRoute.get("/admin", requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const statusFilter = c.req.query("status");
  if (statusFilter && !ORDER_STATUSES.includes(statusFilter as (typeof ORDER_STATUSES)[number])) {
    throw new HttpError(422, "Invalid status filter");
  }

  const rows = await db
    .select()
    .from(orders)
    .where(statusFilter ? eq(orders.status, statusFilter as (typeof ORDER_STATUSES)[number]) : undefined)
    .orderBy(desc(orders.createdAt));

  if (rows.length === 0) return c.json([]);

  const items = await db
    .select()
    .from(orderItems)
    .where(inArray(orderItems.orderId, rows.map((o) => o.id)));

  const itemsByOrder = new Map<string, typeof items>();
  for (const item of items) {
    const list = itemsByOrder.get(item.orderId) ?? [];
    list.push(item);
    itemsByOrder.set(item.orderId, list);
  }

  return c.json(rows.map((order) => ({ ...order, items: itemsByOrder.get(order.id) ?? [] })));
});

// Admin-only: mark a paid order as fulfilled once it's been shipped.
ordersRoute.patch("/admin/:orderNumber/fulfill", requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const [order] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(eq(orders.orderNumber, c.req.param("orderNumber")))
    .limit(1);
  if (!order) throw new HttpError(404, "Order not found");
  if (order.status !== "paid") throw new HttpError(409, "Only paid orders can be marked fulfilled");

  await db.update(orders).set({ status: "fulfilled" }).where(eq(orders.id, order.id));
  return c.json({ ok: true });
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
