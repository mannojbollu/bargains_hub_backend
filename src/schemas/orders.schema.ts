import { z } from "zod";

// No card/payment fields here — those are collected on Stripe's own hosted
// Checkout page, never by this API. This only carries contact/shipping details
// and the cart contents; prices are never trusted from the client, the order
// service re-prices every line from `books`.
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/;
const UK_COUNTRY_NAMES = new Set(["united kingdom", "uk", "gb", "great britain", "england", "scotland", "wales", "northern ireland"]);

export const createOrderSchema = z.object({
  email: z.string().email(),
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  address: z.string().trim().min(1).max(100),
  addressLine2: z.string().trim().max(100).optional(),
  city: z.string().trim().min(1).max(100),
  // We only deliver within the UK (Royal Mail domestic services), so the postcode
  // must be a real UK one; it's normalised to "AB1 2CD" form for the label.
  postcode: z
    .string()
    .transform((p) => p.replace(/\s+/g, "").toUpperCase())
    .refine((p) => UK_POSTCODE.test(p), "Please enter a valid UK postcode")
    .transform((p) => `${p.slice(0, -3)} ${p.slice(-3)}`),
  country: z
    .string()
    .optional()
    .refine((c) => !c || UK_COUNTRY_NAMES.has(c.trim().toLowerCase()), "We currently deliver to UK addresses only")
    .transform(() => "United Kingdom"),
  phone: z.string().trim().max(25).optional(),
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

export const fulfillOrderSchema = z.object({
  trackingNumber: z.string().trim().max(40).optional(),
});
