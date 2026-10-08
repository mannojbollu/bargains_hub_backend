import { Hono } from "hono";
import { createClickDropOrder } from "@/lib/click-drop";
import { orderConfirmationEmail, orderShippedEmail, reviewRequestEmail, sendEmail, type EmailOrder } from "@/lib/email";
import { requireAdmin } from "@/middleware/auth";
import type { Env, Variables } from "@/types/env";

// Admin-only live self-test, run from the "Test Royal Mail & emails" button on
// /admin/orders: checks the Click & Drop key by creating one clearly-labelled test
// order and deleting it immediately, and sends the three customer emails to the
// admin's own inbox (marked [TEST]) so they can see exactly what customers get.
export const diagnostics = new Hono<{ Bindings: Env; Variables: Variables }>();

const CLICK_DROP = "https://api.parcel.royalmail.com/api/v1";

diagnostics.post("/", requireAdmin, async (c) => {
  const adminEmail = c.get("user")!.email;
  const results: Record<string, unknown> = {};

  const key = c.env.CLICK_DROP_API_KEY;
  if (!key) {
    results["clickDrop"] = { ok: false, error: "CLICK_DROP_API_KEY not set" };
  } else {
    const auth = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    const list = await fetch(`${CLICK_DROP}/orders?pageSize=1`, { headers: auth });
    const check: Record<string, unknown> = { keyAccepted: list.ok, status: list.status };
    if (!list.ok) check["error"] = (await list.text()).slice(0, 300);
    if (list.ok) {
      try {
        const ref = `TEST-DELETE-${Date.now() % 1_000_000}`;
        const id = await createClickDropOrder(key, {
          orderReference: ref,
          recipient: {
            address: {
              fullName: "TEST ORDER - PLEASE IGNORE",
              addressLine1: "1 Test Street",
              city: "London",
              postcode: "SW1A 1AA",
              countryCode: "GB",
            },
          },
          packages: [
            {
              weightInGrams: 410,
              packageFormatIdentifier: "largeLetter",
              contents: [{ name: "Test book", quantity: 1, unitValue: 5, unitWeightInGrams: 350 }],
            },
          ],
          orderDate: new Date().toISOString(),
          subtotal: 5,
          shippingCostCharged: 2.99,
          total: 7.99,
          currencyCode: "GBP",
          postageDetails: { sendNotificationsTo: "recipient" },
        });
        const del = await fetch(`${CLICK_DROP}/orders/${id}`, { method: "DELETE", headers: auth });
        check["testOrder"] = { created: true, orderIdentifier: id, reference: ref, deleted: del.ok, deleteStatus: del.status };
        if (!del.ok) check["deleteError"] = (await del.text()).slice(0, 300);
      } catch (err) {
        check["testOrder"] = { created: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    results["clickDrop"] = check;
  }

  const sample: EmailOrder = {
    orderNumber: "BNB-TEST01",
    firstName: "Test",
    lastName: "Customer",
    address: "1 Test Street",
    addressLine2: null,
    city: "London",
    postcode: "SW1A 1AA",
    subtotal: 8.99,
    discount: 0,
    shipping: 2.99,
    total: 11.98,
    trackingNumber: "TT123456789GB",
    items: [{ title: "Test Book", qty: 1, price: 8.99, format: "paperback", slug: null }],
  };
  const emails: Record<string, unknown> = { from: c.env.EMAIL_FROM, to: adminEmail };
  for (const [name, tmpl] of [
    ["confirmation", orderConfirmationEmail],
    ["shipped", orderShippedEmail],
    ["review", reviewRequestEmail],
  ] as const) {
    try {
      const msg = tmpl(c.env, sample);
      const sent = await sendEmail(c.env, { to: adminEmail, ...msg, subject: `[TEST] ${msg.subject}` });
      emails[name] = sent ? "sent" : "RESEND_API_KEY not set";
    } catch (err) {
      emails[name] = `failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  results["email"] = emails;
  return c.json(results);
});
