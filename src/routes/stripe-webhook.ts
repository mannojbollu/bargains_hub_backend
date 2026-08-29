import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type Stripe from "stripe";
import { getDb } from "@/db/client";
import { books, orderItems, orders } from "@/db/schema";
import { getStripe, getStripeCryptoProvider } from "@/lib/stripe";
import type { Env, Variables } from "@/types/env";

export const stripeWebhook = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Tells the warehouse a copy just sold here, so it marks the matching stock item
 * SOLD_OUT and cross-syncs eBay/Amazon quantities — same as an eBay/Amazon sale
 * already does today, just in the other direction. Best-effort: a warehouse-side
 * outage shouldn't fail this webhook's response to Stripe, so failures are only
 * logged. `notificationId` reuses Stripe's own event id, which the warehouse's
 * generic notification ledger uses to ignore retried deliveries.
 */
async function notifyWarehouseOfSale(
  env: Env,
  notificationId: string,
  orderNumber: string,
  db: ReturnType<typeof getDb>,
  orderId: string,
) {
  try {
    const lines = await db
      .select({ isbn: books.isbn, qty: orderItems.qty })
      .from(orderItems)
      .innerJoin(books, eq(books.id, orderItems.bookId))
      .where(eq(orderItems.orderId, orderId));
    if (lines.length === 0) return;

    await fetch(env.WAREHOUSE_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Api-Key": env.WAREHOUSE_WEBHOOK_KEY },
      body: JSON.stringify({
        notificationId,
        orderId: orderNumber,
        items: lines.map((l) => ({ isbn: l.isbn, quantity: l.qty })),
      }),
    });
  } catch (err) {
    console.error("Failed to notify warehouse of sale", orderNumber, err);
  }
}

/**
 * The ONLY place an order is ever marked "paid". Stripe signs every webhook
 * request with STRIPE_WEBHOOK_SECRET, so this is the sole trusted source of
 * payment confirmation — never the client's post-checkout redirect.
 */
stripeWebhook.post("/", async (c) => {
  const signature = c.req.header("stripe-signature");
  if (!signature) return c.json({ error: "Missing stripe-signature header" }, 400);

  const rawBody = await c.req.text();
  const stripe = getStripe(c.env.STRIPE_SECRET_KEY);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET,
      undefined,
      getStripeCryptoProvider(),
    );
  } catch (err) {
    console.error("Stripe webhook signature verification failed", err);
    return c.json({ error: "Invalid signature" }, 400);
  }

  const db = getDb(c.env.DB);

  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.["orderId"];
    if (orderId && session.payment_status === "paid") {
      const paymentIntentId =
        typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null);
      const result = await db
        .update(orders)
        .set({ status: "paid", stripePaymentIntentId: paymentIntentId })
        // Only transition from "pending" — makes retried webhook deliveries a no-op.
        .where(and(eq(orders.id, orderId), eq(orders.status, "pending")));

      // Only notify on the transition that actually happened here, not on a
      // retried delivery that finds the order already paid.
      if (result.meta.changes > 0) {
        const orderNumber = session.metadata?.["orderNumber"] ?? orderId;
        await notifyWarehouseOfSale(c.env, event.id, orderNumber, db, orderId);
      }
    }
  }

  if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const orderId = session.metadata?.["orderId"];
    if (orderId) {
      await db
        .update(orders)
        .set({ status: "cancelled" })
        .where(and(eq(orders.id, orderId), eq(orders.status, "pending")));
    }
  }

  return c.json({ received: true });
});
