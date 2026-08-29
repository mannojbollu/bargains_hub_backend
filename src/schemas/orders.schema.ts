import { z } from "zod";

// No card/payment fields here — those are collected on Stripe's own hosted
// Checkout page, never by this API. This only carries contact/shipping details
// and the cart contents; prices are never trusted from the client, the order
// service re-prices every line from `books`.
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
