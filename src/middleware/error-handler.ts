import type { ErrorHandler } from "hono";
import { ZodError } from "zod";
import { HttpError } from "@/lib/http-error";

export const errorHandler: ErrorHandler = (err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status);
  }
  if (err instanceof ZodError) {
    return c.json({ error: "Invalid request", issues: err.issues }, 422);
  }
  console.error(err);
  return c.json({ error: "Internal server error" }, 500);
};
