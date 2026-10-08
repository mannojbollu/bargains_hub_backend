import { and, eq, gte, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { books, orderItems, orders } from "@/db/schema";
import {
  createClickDropOrder,
  findClickDropOrderByReference,
  getClickDropOrders,
  type ClickDropCreateOrder,
  type ClickDropOrderInfo,
} from "@/lib/click-drop";
import {
  orderConfirmationEmail,
  orderShippedEmail,
  reviewRequestEmail,
  sendEmail,
  type EmailOrder,
} from "@/lib/email";
import type { Env } from "@/types/env";

/**
 * Everything that happens to an order after payment:
 *
 *   paid (Stripe webhook) ──► confirmation email + pushed to Click & Drop
 *   label printed in Click & Drop (picked up by the cron sync) ──► "fulfilled" + shipped email
 *   N days after shipping (cron) ──► review request email
 *
 * Every step is idempotent and claimed with a conditional UPDATE first, so the
 * webhook, the cron job and the admin buttons can overlap without double-sending.
 */

type OrderRow = typeof orders.$inferSelect;
type EmailKind = "confirmation" | "shipped" | "review";

/** Same "YYYY-MM-DD HH:MM:SS" (UTC) format SQLite's current_timestamp uses. */
export function sqlNow(date = new Date()): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

async function loadEmailOrder(db: Database, order: OrderRow): Promise<EmailOrder> {
  const items = await db
    .select({
      title: orderItems.title,
      qty: orderItems.qty,
      price: orderItems.price,
      format: orderItems.format,
      slug: books.slug,
    })
    .from(orderItems)
    .leftJoin(books, eq(books.id, orderItems.bookId))
    .where(eq(orderItems.orderId, order.id));
  return { ...order, items };
}

const EMAIL_COLUMN = {
  confirmation: orders.confirmationEmailSentAt,
  shipped: orders.shippedEmailSentAt,
  review: orders.reviewEmailSentAt,
} as const;

const EMAIL_FIELD = {
  confirmation: "confirmationEmailSentAt",
  shipped: "shippedEmailSentAt",
  review: "reviewEmailSentAt",
} as const;

const TEMPLATE = {
  confirmation: orderConfirmationEmail,
  shipped: orderShippedEmail,
  review: reviewRequestEmail,
} as const;

/** Sends one email at most once per order. Returns true if it was sent by this call. */
export async function sendOrderEmail(env: Env, db: Database, orderId: string, kind: EmailKind): Promise<boolean> {
  if (!env.RESEND_API_KEY) return false;

  // Claim it first — if another invocation already did, changes is 0 and we stop.
  const claim = await db
    .update(orders)
    .set({ [EMAIL_FIELD[kind]]: sqlNow() })
    .where(and(eq(orders.id, orderId), isNull(EMAIL_COLUMN[kind])));
  if (claim.meta.changes === 0) return false;

  try {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) return false;
    const msg = TEMPLATE[kind](env, await loadEmailOrder(db, order));
    return await sendEmail(env, { to: order.email, ...msg });
  } catch (err) {
    // Release the claim so the next cron run retries it.
    await db.update(orders).set({ [EMAIL_FIELD[kind]]: null }).where(eq(orders.id, orderId));
    console.error(`Failed to send ${kind} email for order`, orderId, err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Royal Mail Click & Drop
// ---------------------------------------------------------------------------

// Rough shipping weights, used only to pre-fill the parcel in Click & Drop — you
// can still adjust weight/format there before printing the label.
const WEIGHT_GRAMS: Record<string, number> = { paperback: 350, hardback: 700, audiobook: 200 };
const PACKAGING_GRAMS = 60;
// Royal Mail Large Letter: max 750g and 2.5cm thick — a single paperback usually fits.
const LARGE_LETTER_MAX_GRAMS = 750;

async function buildClickDropOrder(env: Env, db: Database, order: OrderRow): Promise<ClickDropCreateOrder> {
  const items = await db
    .select({ title: orderItems.title, qty: orderItems.qty, price: orderItems.price, format: orderItems.format })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  const contents = items.map((i) => ({
    name: i.title.slice(0, 800),
    quantity: i.qty,
    unitValue: i.price,
    unitWeightInGrams: WEIGHT_GRAMS[i.format] ?? 400,
  }));
  const weight = contents.reduce((sum, c) => sum + c.unitWeightInGrams * c.quantity, PACKAGING_GRAMS);
  const units = items.reduce((sum, i) => sum + i.qty, 0);
  const isSinglePaperback = units === 1 && items[0]?.format === "paperback";
  const format = isSinglePaperback && weight <= LARGE_LETTER_MAX_GRAMS ? "largeLetter" : "smallParcel";

  return {
    orderReference: order.orderNumber,
    recipient: {
      address: {
        fullName: `${order.firstName} ${order.lastName}`.slice(0, 210),
        addressLine1: order.address.slice(0, 100),
        addressLine2: order.addressLine2?.slice(0, 100) || undefined,
        city: order.city.slice(0, 100),
        postcode: order.postcode,
        countryCode: "GB",
      },
      phoneNumber: order.phone || undefined,
      emailAddress: order.email,
    },
    packages: [{ weightInGrams: weight, packageFormatIdentifier: format, contents }],
    orderDate: new Date(`${(order.paidAt ?? order.createdAt).replace(" ", "T")}Z`).toISOString(),
    subtotal: Math.round((order.subtotal - order.discount) * 100) / 100,
    shippingCostCharged: order.shipping,
    total: order.total,
    currencyCode: "GBP",
    postageDetails: {
      sendNotificationsTo: "recipient",
      serviceCode: env.CLICK_DROP_SERVICE_CODE || undefined,
    },
  };
}

/**
 * Pushes a paid order into Click & Drop. `force` (admin button) also retries
 * failed/legacy orders; the automatic path only ever pushes "pending" ones.
 * Looks the order up by reference first, so a retry never creates a duplicate.
 */
export async function pushOrderToClickDrop(
  env: Env,
  db: Database,
  orderId: string,
  { force = false } = {},
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = env.CLICK_DROP_API_KEY;
  if (!apiKey) return { ok: false, error: "CLICK_DROP_API_KEY is not configured" };

  const claimable = force
    ? (["pending", "failed", "skipped", "sending"] as const)
    : (["pending"] as const);
  const claim = await db
    .update(orders)
    .set({ clickDropStatus: "sending", clickDropError: null })
    .where(
      and(
        eq(orders.id, orderId),
        inArray(orders.status, ["paid", "fulfilled"]),
        inArray(orders.clickDropStatus, [...claimable]),
      ),
    );
  if (claim.meta.changes === 0) return { ok: false, error: "Order is not waiting to be sent to Click & Drop" };

  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) return { ok: false, error: "Order not found" };

  try {
    const existing = await findClickDropOrderByReference(apiKey, order.orderNumber);
    const clickDropOrderId =
      existing?.orderIdentifier ?? (await createClickDropOrder(apiKey, await buildClickDropOrder(env, db, order)));
    await db
      .update(orders)
      .set({ clickDropStatus: "sent", clickDropOrderId, clickDropError: null })
      .where(eq(orders.id, orderId));
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error("Click & Drop push failed", order.orderNumber, error);
    await db
      .update(orders)
      .set({ clickDropStatus: "failed", clickDropError: error.slice(0, 1000) })
      .where(eq(orders.id, orderId));
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle transitions
// ---------------------------------------------------------------------------

/** Called from the Stripe webhook right after an order transitions to "paid". */
export async function onOrderPaid(env: Env, db: Database, orderId: string) {
  await Promise.allSettled([
    sendOrderEmail(env, db, orderId, "confirmation"),
    pushOrderToClickDrop(env, db, orderId),
  ]);
}

/**
 * Marks a paid order as shipped and emails the customer. Used both by the Click &
 * Drop sync (once a label is printed) and the admin "Mark as shipped" button.
 */
export async function markOrderShipped(
  env: Env,
  db: Database,
  orderId: string,
  { trackingNumber, shippedAt }: { trackingNumber?: string | null | undefined; shippedAt?: string | null | undefined } = {},
): Promise<boolean> {
  const result = await db
    .update(orders)
    .set({
      status: "fulfilled",
      trackingNumber: trackingNumber?.trim() || null,
      shippedAt: shippedAt ?? sqlNow(),
    })
    .where(and(eq(orders.id, orderId), eq(orders.status, "paid")));
  if (result.meta.changes === 0) return false;
  await sendOrderEmail(env, db, orderId, "shipped");
  return true;
}

function toSqlTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : sqlNow(d);
}

/**
 * Polls Click & Drop for every paid-but-unshipped order we've pushed. As soon as a
 * label has been printed (or the order is marked despatched/manifested), the order
 * is marked shipped here with its tracking number and the customer is emailed.
 */
export async function syncClickDropShipments(env: Env, db: Database): Promise<{ checked: number; shipped: number }> {
  const apiKey = env.CLICK_DROP_API_KEY;
  if (!apiKey) return { checked: 0, shipped: 0 };

  const waiting = await db
    .select({ id: orders.id, clickDropOrderId: orders.clickDropOrderId })
    .from(orders)
    .where(and(eq(orders.status, "paid"), eq(orders.clickDropStatus, "sent"), isNotNull(orders.clickDropOrderId)));

  let shipped = 0;
  for (let i = 0; i < waiting.length; i += 50) {
    const batch = waiting.slice(i, i + 50);
    let infos: ClickDropOrderInfo[];
    try {
      infos = await getClickDropOrders(apiKey, batch.map((o) => o.clickDropOrderId!));
    } catch (err) {
      // A batch fails as a whole if any one order was deleted in Click & Drop —
      // fall back to one-by-one so the others still sync.
      console.warn("Click & Drop batch lookup failed, retrying individually", err);
      infos = [];
      for (const o of batch) {
        try {
          infos.push(...(await getClickDropOrders(apiKey, [o.clickDropOrderId!])));
        } catch (e) {
          console.warn("Click & Drop lookup failed for order", o.clickDropOrderId, e);
        }
      }
    }

    const byClickDropId = new Map(infos.map((info) => [info.orderIdentifier, info]));
    for (const o of batch) {
      const info = byClickDropId.get(o.clickDropOrderId!);
      if (!info) continue;
      const dispatchedAt = info.shippedOn ?? info.manifestedOn ?? info.printedOn;
      if (!dispatchedAt) continue;
      const ok = await markOrderShipped(env, db, o.id, {
        trackingNumber: info.trackingNumber,
        shippedAt: toSqlTime(dispatchedAt),
      });
      if (ok) shipped++;
    }
  }
  return { checked: waiting.length, shipped };
}

/** Everything the cron trigger does, every 15 minutes. */
export async function runScheduledJobs(env: Env, db: Database) {
  // 1. Safety net for the webhook's best-effort work: orders paid >10 min ago
  //    whose confirmation email or Click & Drop push never happened.
  // Retries only look back 3 days, so e.g. switching email on later never sends
  // stale "your order is confirmed/shipped" emails for weeks-old orders.
  const tenMinutesAgo = sqlNow(new Date(Date.now() - 10 * 60 * 1000));
  const threeDaysAgo = sqlNow(new Date(Date.now() - 3 * 24 * 60 * 60 * 1000));
  const stragglers = await db
    .select({ id: orders.id, clickDropStatus: orders.clickDropStatus, confirmationEmailSentAt: orders.confirmationEmailSentAt })
    .from(orders)
    .where(
      and(
        inArray(orders.status, ["paid", "fulfilled"]),
        lte(orders.paidAt, tenMinutesAgo),
        gte(orders.paidAt, threeDaysAgo),
        sql`(${orders.clickDropStatus} = 'pending' OR ${orders.confirmationEmailSentAt} IS NULL)`,
      ),
    )
    .limit(50);
  for (const o of stragglers) {
    if (!o.confirmationEmailSentAt) await sendOrderEmail(env, db, o.id, "confirmation");
    if (o.clickDropStatus === "pending") await pushOrderToClickDrop(env, db, o.id);
  }

  // 2. Pick up labels printed in Click & Drop → mark shipped + email tracking.
  await syncClickDropShipments(env, db);

  // 3. Shipped emails that failed to send the first time.
  const unsentShipped = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(eq(orders.status, "fulfilled"), gte(orders.shippedAt, threeDaysAgo), isNull(orders.shippedEmailSentAt)),
    )
    .limit(50);
  for (const o of unsentShipped) await sendOrderEmail(env, db, o.id, "shipped");

  // 4. Review requests, a few days after dispatch.
  const delayDays = Number(env.REVIEW_EMAIL_DELAY_DAYS) || 7;
  const reviewCutoff = sqlNow(new Date(Date.now() - delayDays * 24 * 60 * 60 * 1000));
  const dueForReview = await db
    .select({ id: orders.id })
    .from(orders)
    .where(
      and(
        eq(orders.status, "fulfilled"),
        isNotNull(orders.shippedAt),
        lte(orders.shippedAt, reviewCutoff),
        isNull(orders.reviewEmailSentAt),
      ),
    )
    .limit(50);
  for (const o of dueForReview) await sendOrderEmail(env, db, o.id, "review");
}
