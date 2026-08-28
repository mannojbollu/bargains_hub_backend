import { Hono } from "hono";
import { HttpError } from "@/lib/http-error";
import type { Env, Variables } from "@/types/env";

export const images = new Hono<{ Bindings: Env; Variables: Variables }>();

/**
 * Public — book covers need to be viewable on the storefront by anyone, logged
 * in or not. Streams straight from R2 rather than requiring a public bucket/
 * custom domain, so this works as soon as the BUCKET binding exists.
 */
images.get("/:key{.+}", async (c) => {
  if (!c.env.BUCKET) throw new HttpError(503, "R2 storage is not configured yet");

  const object = await c.env.BUCKET.get(c.req.param("key"));
  if (!object) throw new HttpError(404, "Image not found");

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");

  return new Response(object.body, { headers });
});
