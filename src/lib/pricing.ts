import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import { GUEST_USER_ID, books, coupons, orders } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import type { createOrderSchema } from "@/schemas/orders.schema";
import type { z } from "zod";

// UK delivery is free on every order.
const SHIPPING = 0;

type OrderLines = z.infer<typeof createOrderSchema>["lines"];

// Who's checking out, so a coupon can be limited to one use per customer.
export interface Customer {
  email: string;
  userId: string | null;
}

// Orders that count as having "used" a coupon. Pending (abandoned or unpaid)
// checkouts don't, and neither do cancelled or refunded ones, so a customer whose
// order fell through can still use their code.
const COUPON_USED_STATUSES = ["paid", "fulfilled"] as const;

// Lower-cases and drops a "+tag", so jane+1@x.com and Jane@x.com count as the
// same customer.
function normalizeEmail(email: string): string {
  const [local = "", domain = ""] = email.trim().toLowerCase().split("@");
  return `${local.split("+")[0]}@${domain}`;
}

/**
 * Re-derives an order's price from the `books` table and validates stock/coupon.
 * Never trust price/subtotal/total from the client — this is the only place an
 * order's charge amount is computed, shared by order creation and (indirectly)
 * the Stripe Checkout Session amount.
 */
export async function priceLines(
  db: Database,
  lines: OrderLines,
  couponCode: string | undefined,
  customer: Customer,
) {
  const bookIds = [...new Set(lines.map((l) => l.bookId))];
  const rows = await db.select().from(books).where(inArray(books.id, bookIds));
  const byId = new Map(rows.map((b) => [b.id, b]));

  for (const line of lines) {
    const book = byId.get(line.bookId);
    if (!book) throw new HttpError(400, `Unknown book: ${line.bookId}`);
    if (book.stock === "out_of_stock") throw new HttpError(409, `${book.title} is out of stock`);
  }

  const subtotal = lines.reduce((sum, l) => sum + byId.get(l.bookId)!.price * l.qty, 0);

  let discount = 0;
  let resolvedCouponCode: string | null = null;
  if (couponCode) {
    const [coupon] = await db
      .select()
      .from(coupons)
      .where(and(eq(coupons.code, couponCode.toUpperCase()), eq(coupons.active, true)))
      .limit(1);
    if (!coupon) throw new HttpError(400, "Invalid or expired coupon code");

    // Every coupon is one use per customer: matched on the signed-in account or on
    // the email address, so guests can't reuse it either.
    const previous = await db
      .select({ email: orders.email, userId: orders.userId })
      .from(orders)
      .where(and(eq(orders.couponCode, coupon.code), inArray(orders.status, [...COUPON_USED_STATUSES])));
    const email = normalizeEmail(customer.email);
    const alreadyUsed = previous.some(
      (o) =>
        normalizeEmail(o.email) === email ||
        (customer.userId !== null && customer.userId !== GUEST_USER_ID && o.userId === customer.userId),
    );
    if (alreadyUsed) {
      throw new HttpError(400, `You've already used the code ${coupon.code} — it's one use per customer`);
    }
    discount = Math.round(subtotal * coupon.percentOff) / 100;
    resolvedCouponCode = coupon.code;
  }

  const net = subtotal - discount;
  const shipping = SHIPPING;
  const total = Math.round((net + shipping) * 100) / 100;

  return { byId, subtotal, discount, couponCode: resolvedCouponCode, shipping, total };
}
