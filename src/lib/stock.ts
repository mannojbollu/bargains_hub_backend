import { HttpError } from "@/lib/http-error";

// Same thresholds as products.ts's deriveStockFromQuantity, as SQL so the status is
// recomputed in the very statement that changes the quantity.
const stockStatusFor = (qtyExpr: string) =>
  `CASE WHEN ${qtyExpr} <= 0 THEN 'out_of_stock' WHEN ${qtyExpr} <= 2 THEN 'low_stock' ELSE 'in_stock' END`;

/**
 * Books the warehouse pushes an exact count for are quantity-tracked. A book added by
 * hand in the admin with no quantity (0, but not marked out of stock) predates
 * quantity tracking -- it keeps selling on its status alone, as before.
 */
export function isQuantityTracked(book: {
  stockQuantity: number;
  stock: string;
}): boolean {
  return !(book.stockQuantity === 0 && book.stock !== "out_of_stock");
}

/**
 * Takes the ordered copies off each quantity-tracked book. Each decrement is
 * conditional on enough copies being left, so two shoppers racing for the last copy
 * can't both get it. All-or-nothing: if any book is short, the ones already taken are
 * put back and a 409 says how many are left. Returns the reserved qty per book id.
 */
export async function reserveStock(
  d1: D1Database,
  wanted: Map<string, { qty: number; title: string; tracked: boolean }>,
): Promise<Map<string, number>> {
  const tracked = [...wanted].filter(([, w]) => w.tracked);
  const reserved = new Map<string, number>();
  if (tracked.length === 0) return reserved;

  const results = await d1.batch(
    tracked.map(([bookId, w]) =>
      d1
        .prepare(
          `UPDATE books SET stock_quantity = stock_quantity - ?1, stock = ${stockStatusFor("stock_quantity - ?1")},
           updated_at = current_timestamp WHERE id = ?2 AND stock_quantity >= ?1`,
        )
        .bind(w.qty, bookId),
    ),
  );

  const short: string[] = [];
  tracked.forEach(([bookId, w], i) => {
    if ((results[i]?.meta.changes ?? 0) > 0) reserved.set(bookId, w.qty);
    else short.push(bookId);
  });
  if (short.length === 0) return reserved;

  await releaseStock(d1, reserved);
  const left = await d1
    .prepare(
      `SELECT id, stock_quantity AS q FROM books WHERE id IN (${short.map(() => "?").join(",")})`,
    )
    .bind(...short)
    .all<{ id: string; q: number }>();
  const message = left.results
    .map((r) => {
      const title = wanted.get(r.id)!.title;
      return r.q <= 0
        ? `${title} is out of stock`
        : `Only ${r.q} ${r.q === 1 ? "copy" : "copies"} of ${title} left`;
    })
    .join(". ");
  throw new HttpError(409, message);
}

/** Puts reserved copies back (cancelled/expired checkout, or a reservation being rolled back). */
export async function releaseStock(
  d1: D1Database,
  reserved: Map<string, number>,
): Promise<void> {
  const entries = [...reserved].filter(([, qty]) => qty > 0);
  if (entries.length === 0) return;
  await d1.batch(
    entries.map(([bookId, qty]) =>
      d1
        .prepare(
          `UPDATE books SET stock_quantity = stock_quantity + ?1, stock = ${stockStatusFor("stock_quantity + ?1")},
           updated_at = current_timestamp WHERE id = ?2`,
        )
        .bind(qty, bookId),
    ),
  );
}

/** Gives back everything an order reserved. Call only on the transition out of "pending". */
export async function releaseOrderStock(
  d1: D1Database,
  orderId: string,
): Promise<void> {
  const { results } = await d1
    .prepare(
      "SELECT book_id, SUM(reserved_qty) AS qty FROM order_items WHERE order_id = ? GROUP BY book_id",
    )
    .bind(orderId)
    .all<{ book_id: string; qty: number }>();
  await releaseStock(d1, new Map(results.map((r) => [r.book_id, r.qty])));
}

/**
 * Copies of a book currently held by unpaid checkouts. The warehouse pushes the
 * website's whole share; subtracting these keeps a push from silently cancelling
 * reservations (which would let a cancelled checkout later return copies twice).
 */
export async function pendingReservedQty(
  d1: D1Database,
  bookId: string,
): Promise<number> {
  const row = await d1
    .prepare(
      `SELECT COALESCE(SUM(oi.reserved_qty), 0) AS qty FROM order_items oi
       JOIN orders o ON o.id = oi.order_id WHERE oi.book_id = ? AND o.status = 'pending'`,
    )
    .bind(bookId)
    .first<{ qty: number }>();
  return row?.qty ?? 0;
}
