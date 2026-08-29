import { and, eq, inArray } from "drizzle-orm";
import type { Database } from "@/db/client";
import { books, coupons } from "@/db/schema";
import { HttpError } from "@/lib/http-error";
import type { createOrderSchema } from "@/schemas/orders.schema";
import type { z } from "zod";

const FREE_SHIPPING_THRESHOLD = 25;
const SHIPPING_FLAT = 2.99;

type OrderLines = z.infer<typeof createOrderSchema>["lines"];

/**
 * Re-derives an order's price from the `books` table and validates stock/coupon.
 * Never trust price/subtotal/total from the client — this is the only place an
 * order's charge amount is computed, shared by order creation and (indirectly)
 * the Stripe Checkout Session amount.
 */
export async function priceLines(db: Database, lines: OrderLines, couponCode: string | undefined) {
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
    discount = Math.round(subtotal * coupon.percentOff) / 100;
    resolvedCouponCode = coupon.code;
  }

  const net = subtotal - discount;
  const shipping = net >= FREE_SHIPPING_THRESHOLD ? 0 : SHIPPING_FLAT;
  const total = Math.round((net + shipping) * 100) / 100;

  return { byId, subtotal, discount, couponCode: resolvedCouponCode, shipping, total };
}
