import { z } from "zod";

export const productQuerySchema = z.object({
  category: z.string().optional(),
  q: z.string().optional(),
  // Comma-separated in the query string, e.g. formats=paperback,hardback
  formats: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",") : undefined)),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  minRating: z.coerce.number().optional(),
  inStockOnly: z.coerce.boolean().optional(),
  bestseller: z.coerce.boolean().optional(),
  isNew: z.coerce.boolean().optional(),
  sort: z
    .enum(["relevance", "price-asc", "price-desc", "newest", "bestselling", "rating", "deals"])
    .optional(),
  page: z.coerce.number().int().positive().optional(),
  perPage: z.coerce.number().int().positive().max(48).optional(),
});

export const searchSuggestQuerySchema = z.object({
  q: z.string().min(1),
});

export const createReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().min(1).max(120),
  body: z.string().min(1).max(2000),
});

const bookFormat = z.enum(["paperback", "hardback", "audiobook"]);
const stockStatus = z.enum(["in_stock", "low_stock", "out_of_stock", "pre_order"]);

export const createBookSchema = z.object({
  title: z.string().min(1).max(300),
  author: z.string().min(1).max(200),
  isbn: z.string().min(1).max(30),
  category: z.string().min(1).max(60),
  formats: z.array(bookFormat).min(1),
  format: bookFormat,
  price: z.number().positive(),
  originalPrice: z.number().positive(),
  stock: stockStatus.default("in_stock"),
  publisher: z.string().min(1).max(200),
  pages: z.number().int().positive(),
  language: z.string().min(1).max(60),
  publishedAt: z.string().min(1).max(20),
  description: z.string().max(4000).default(""),
  tags: z.array(z.string()).default([]),
  coverFrom: z.string().default("#1f4735"),
  coverTo: z.string().default("#3f7d5c"),
  bestseller: z.boolean().default(false),
  isNew: z.boolean().default(false),
});

export const updateBookSchema = createBookSchema.partial();

