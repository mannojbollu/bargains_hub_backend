import { Hono } from "hono";
import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db/client";
import { GUEST_USER_ID, orderItems, orders } from "@/db/schema";
import { createOrderSchema, fulfillOrderSchema } from "@/schemas/orders.schema";
import { newId, newOrderNumber } from "@/lib/ids";
import { HttpError } from "@/lib/http-error";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { priceLines } from "@/lib/pricing";
import { isQuantityTracked, releaseStock, reserveStock } from "@/lib/stock";
import { getStripe } from "@/lib/stripe";
import { markOrderShipped, pushOrderToClickDrop, syncClickDropShipments } from "@/lib/fulfillment";
import { requireAdmin, requireAuth } from "@/middleware/auth";
import type { Env, Variables } from "@/types/env";

export const ordersRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

// Checkout works with or without an account: signed-in shoppers' orders go in their
// order history, guests' are filed under GUEST_USER_ID. Either way the order gets a
// secret access token, so the success page and email links work without a login.
// Every other route below needs a login (and the admin ones an admin).

// Caps how many checkouts one IP can start per 15 minutes — each one holds stock for
// up to half an hour, so this stops anyone tying up the shelves with fake checkouts.
const CHECKOUT_RATE_LIMIT = 20;

function newAccessToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function resolveFrontendOrigin(c: { req: { header: (name: string) => string | undefined }; env: Env }) {
  const allowed = c.env.FRONTEND_ORIGIN.split(",").map((o) => o.trim());
  const origin = c.req.header("Origin");
  return origin && allowed.includes(origin) ? origin : (allowed[0] ?? "");
}

ordersRoute.post("/", async (c) => {
  const body = createOrderSchema.parse(await c.req.json());
  const db = getDb(c.env.DB);
  const user = c.get("user");

  const limit = await checkRateLimit(db, `checkout:${clientIp(c.req.raw)}`, CHECKOUT_RATE_LIMIT);
  if (!limit.allowed) {
    c.header("Retry-After", String(limit.retryAfterSeconds));
    throw new HttpError(429, "Too many checkout attempts — please wait a few minutes and try again");
  }

  const { byId, subtotal, discount, couponCode, shipping, total } = await priceLines(
    db,
    body.lines,
    body.couponCode,
  );

  // Copies are reserved now, at checkout, rather than when payment lands — otherwise
  // two shoppers could both pay for the last copy. Released again if the checkout is
  // abandoned or fails (stripe-webhook.ts) or if anything below fails.
  const wanted = new Map<string, { qty: number; title: string; tracked: boolean }>();
  for (const l of body.lines) {
    const book = byId.get(l.bookId)!;
    const prev = wanted.get(book.id);
    wanted.set(book.id, { qty: (prev?.qty ?? 0) + l.qty, title: book.title, tracked: isQuantityTracked(book) });
  }
  const reserved = await reserveStock(c.env.DB, wanted);

  const orderId = newId();
  const orderNumber = newOrderNumber();
  const accessToken = newAccessToken();

  try {
    // Order is created as "pending" — it only becomes "paid" once the Stripe
    // webhook confirms payment server-to-server. Nothing the client sends after
    // this point can mark an order paid.
    await db.insert(orders).values({
      id: orderId,
      orderNumber,
      userId: user?.id ?? GUEST_USER_ID,
      email: body.email,
      firstName: body.firstName,
      lastName: body.lastName,
      address: body.address,
      addressLine2: body.addressLine2 || null,
      city: body.city,
      postcode: body.postcode,
      country: body.country,
      phone: body.phone || null,
      subtotal,
      discount,
      shipping,
      total,
      couponCode,
      status: "pending",
      accessToken,
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
          reservedQty: reserved.has(book.id) ? l.qty : 0,
        };
      }),
    );
  } catch (err) {
    await releaseStock(c.env.DB, reserved);
    throw err;
  }

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
      success_url: `${frontendOrigin}/order/${orderNumber}?token=${accessToken}`,
      cancel_url: `${frontendOrigin}/checkout?cancelled=1`,
      metadata: { orderId, orderNumber, userId: user?.id ?? GUEST_USER_ID },
      // Stripe's shortest allowed window (30 min, plus a minute's margin) instead of
      // its 24h default, so an abandoned checkout gives its reserved copies back soon.
      expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
    });

    await db.update(orders).set({ stripeSessionId: session.id }).where(eq(orders.id, orderId));

    return c.json({ orderNumber, total, checkoutUrl: session.url }, 201);
  } catch (err) {
    // Payment session couldn't be created — don't leave a dangling pending order
    // or copies reserved for it.
    await db.delete(orders).where(eq(orders.id, orderId));
    await releaseStock(c.env.DB, reserved);
    console.error("Stripe checkout session creation failed", err);
    throw new HttpError(503, "Could not start payment — please try again");
  }
});

ordersRoute.get("/", requireAuth, async (c) => {
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
const ORDER_STATUSES = ["pending", "paid", "fulfilled", "cancelled", "refunded"] as const;

ordersRoute.get("/admin", requireAuth, requireAdmin, async (c) => {
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

async function findOrderId(db: ReturnType<typeof getDb>, orderNumber: string) {
  const [order] = await db
    .select({ id: orders.id, status: orders.status })
    .from(orders)
    .where(eq(orders.orderNumber, orderNumber))
    .limit(1);
  if (!order) throw new HttpError(404, "Order not found");
  return order;
}

// Admin-only: mark a paid order as shipped (optionally with a Royal Mail tracking
// number) and email the customer. Orders pushed to Click & Drop normally get this
// automatically once their label is printed — this is the manual override.
ordersRoute.patch("/admin/:orderNumber/fulfill", requireAuth, requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const body = fulfillOrderSchema.parse(await c.req.json().catch(() => ({})));
  const order = await findOrderId(db, c.req.param("orderNumber"));
  if (order.status !== "paid") throw new HttpError(409, "Only paid orders can be marked fulfilled");

  await markOrderShipped(c.env, db, order.id, { trackingNumber: body.trackingNumber });
  return c.json({ ok: true });
});

// Admin-only: (re)send one order to Royal Mail Click & Drop — for orders that
// failed validation there, or that were placed before the integration existed.
ordersRoute.post("/admin/:orderNumber/click-drop", requireAuth, requireAdmin, async (c) => {
  const db = getDb(c.env.DB);
  const order = await findOrderId(db, c.req.param("orderNumber"));
  if (order.status !== "paid") throw new HttpError(409, "Only paid, unshipped orders can be sent to Click & Drop");

  const result = await pushOrderToClickDrop(c.env, db, order.id, { force: true });
  if (!result.ok) throw new HttpError(422, result.error ?? "Click & Drop push failed");
  return c.json({ ok: true });
});

// Admin-only: check Click & Drop for printed labels right now instead of waiting
// for the next 15-minute cron run.
ordersRoute.post("/admin/sync-click-drop", requireAuth, requireAdmin, async (c) => {
  if (!c.env.CLICK_DROP_API_KEY) throw new HttpError(503, "Click & Drop isn't configured (CLICK_DROP_API_KEY)");
  const db = getDb(c.env.DB);
  return c.json(await syncClickDropShipments(c.env, db));
});

// Visible to the account that placed it, or to anyone holding its access token (the
// link in the success redirect and the order emails) — which is how guests see theirs.
ordersRoute.get("/:orderNumber", async (c) => {
  const db = getDb(c.env.DB);
  const user = c.get("user");
  const token = c.req.query("token");
  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.orderNumber, c.req.param("orderNumber")))
    .limit(1);
  const ownsOrder = !!user && user.id !== GUEST_USER_ID && order?.userId === user.id;
  const hasToken = !!token && !!order?.accessToken && timingSafeEqual(token, order.accessToken);
  if (!order || !(ownsOrder || hasToken)) throw new HttpError(404, "Order not found");

  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
  const { accessToken: _accessToken, userId, ...rest } = order;
  return c.json({ ...rest, isGuest: userId === GUEST_USER_ID, items });
});
