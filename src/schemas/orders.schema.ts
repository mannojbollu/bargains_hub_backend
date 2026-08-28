import { z } from "zod";

// Deliberately no payment fields — there's no real payment gateway wired up, so the
// backend only ever needs contact/shipping details and the cart contents. Prices are
// never trusted from the client; the order service re-prices every line from `books`.
export const createOrderSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  address: z.string().min(1).max(300),
  city: z.string().min(1).max(120),
  postcode: z.string().min(1).max(20),
  country: z.string().min(1).max(120),
  couponCode: z.string().optional(),
  lines: z
    .array(
      z.object({
        bookId: z.string().min(1),
        format: z.enum(["paperback", "hardback", "audiobook"]),
        qty: z.number().int().positive().max(99),
      }),
    )
    .min(1),
});
