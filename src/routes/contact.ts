import { Hono } from "hono";
import { getDb } from "@/db/client";
import { contactFormEmail, sendEmail } from "@/lib/email";
import { HttpError } from "@/lib/http-error";
import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { contactSchema } from "@/schemas/contact.schema";
import type { Env, Variables } from "@/types/env";

// Public contact form: emails the message to CONTACT_EMAIL with the customer's
// address as reply-to, so staff can answer straight from their inbox.
export const contact = new Hono<{ Bindings: Env; Variables: Variables }>();

contact.post("/", async (c) => {
  const db = getDb(c.env.DB);
  const rate = await checkRateLimit(db, `${clientIp(c.req.raw)}:contact`, 5);
  if (!rate.allowed) throw new HttpError(429, "Too many messages — try again in a few minutes");

  const body = contactSchema.parse(await c.req.json());
  const to = c.env.CONTACT_EMAIL || c.env.EMAIL_REPLY_TO;
  if (!to) throw new HttpError(503, "Contact form isn't set up yet — please email us directly");

  const sent = await sendEmail(c.env, { to, replyTo: body.email, ...contactFormEmail(c.env, body) });
  if (!sent) throw new HttpError(503, "Contact form isn't set up yet — please email us directly");
  return c.json({ ok: true });
});
