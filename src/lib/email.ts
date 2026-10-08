import type { Env } from "@/types/env";
import { royalMailTrackingUrl } from "@/lib/click-drop";

/**
 * Transactional email via Resend's HTTP API (no SDK needed on Workers).
 * Returns false — rather than throwing — when email isn't configured, so local
 * dev and a half-configured deploy keep working; callers treat that as "not sent".
 */
export async function sendEmail(
  env: Env,
  msg: { to: string; subject: string; html: string; text: string },
): Promise<boolean> {
  if (!env.RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — skipping email", msg.subject, msg.to);
    return false;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [msg.to],
      reply_to: env.EMAIL_REPLY_TO || undefined,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface EmailOrder {
  orderNumber: string;
  firstName: string;
  lastName: string;
  address: string;
  addressLine2: string | null;
  city: string;
  postcode: string;
  subtotal: number;
  discount: number;
  shipping: number;
  total: number;
  trackingNumber: string | null;
  items: { title: string; qty: number; price: number; format: string; slug: string | null }[];
}

const BRAND = "BargainNewBooks";
const GREEN = "#1f4d33";
const AMBER = "#c98a1e";
const CREAM = "#f8f3e8";
const INK = "#2b231c";
const MUTED = "#6b6259";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const money = (n: number) => `£${n.toFixed(2)}`;

function button(href: string, label: string, color = GREEN) {
  return `<a href="${esc(href)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:6px;font-size:15px">${esc(label)}</a>`;
}

function layout(env: Env, preheader: string, body: string) {
  const site = env.SITE_URL.replace(/\/$/, "");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${CREAM};font-family:Georgia,'Times New Roman',serif;color:${INK}">
<span style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${CREAM}"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e8dfcc">
<tr><td style="background:${GREEN};padding:20px 28px"><a href="${esc(site)}" style="color:#ffffff;text-decoration:none;font-size:22px;font-weight:700">${BRAND}</a></td></tr>
<tr><td style="padding:28px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55">${body}</td></tr>
<tr><td style="padding:18px 28px;background:#faf7f0;font-family:Helvetica,Arial,sans-serif;font-size:12px;color:${MUTED};line-height:1.5">
Questions? Just reply to this email or visit <a href="${esc(site)}/contact" style="color:${MUTED}">our contact page</a>.<br>
<a href="${esc(site)}/shipping-returns" style="color:${MUTED}">Shipping &amp; returns</a> · <a href="${esc(site)}" style="color:${MUTED}">${esc(site.replace(/^https?:\/\//, ""))}</a>
</td></tr></table></td></tr></table></body></html>`;
}

function itemsTable(order: EmailOrder, withTotals: boolean) {
  const rows = order.items
    .map(
      (i) =>
        `<tr><td style="padding:6px 0;border-bottom:1px solid #eee">${esc(i.title)} <span style="color:${MUTED}">(${esc(i.format)}) × ${i.qty}</span></td><td align="right" style="padding:6px 0;border-bottom:1px solid #eee;white-space:nowrap">${money(i.price * i.qty)}</td></tr>`,
    )
    .join("");
  const totals = withTotals
    ? `<tr><td style="padding:6px 0;color:${MUTED}">Subtotal</td><td align="right">${money(order.subtotal)}</td></tr>` +
      (order.discount > 0
        ? `<tr><td style="padding:2px 0;color:${MUTED}">Discount</td><td align="right">−${money(order.discount)}</td></tr>`
        : "") +
      `<tr><td style="padding:2px 0;color:${MUTED}">Delivery</td><td align="right">${order.shipping === 0 ? "Free" : money(order.shipping)}</td></tr>` +
      `<tr><td style="padding:8px 0;font-weight:700;border-top:2px solid ${INK}">Total</td><td align="right" style="padding:8px 0;font-weight:700;border-top:2px solid ${INK}">${money(order.total)}</td></tr>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:12px 0 20px">${rows}${totals}</table>`;
}

function addressBlock(order: EmailOrder) {
  return [`${order.firstName} ${order.lastName}`, order.address, order.addressLine2, order.city, order.postcode]
    .filter(Boolean)
    .map((l) => esc(l!))
    .join("<br>");
}

function itemsText(order: EmailOrder) {
  return order.items.map((i) => `- ${i.title} (${i.format}) x${i.qty}  ${money(i.price * i.qty)}`).join("\n");
}

export function orderConfirmationEmail(env: Env, order: EmailOrder) {
  const site = env.SITE_URL.replace(/\/$/, "");
  const orderUrl = `${site}/order/${order.orderNumber}`;
  const html = layout(
    env,
    `Thanks for your order ${order.orderNumber} — we're getting it ready.`,
    `<h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 8px">Thanks for your order, ${esc(order.firstName)}!</h1>
<p style="margin:0 0 16px">We've received your payment and we're getting your books ready. We'll email you again with a Royal Mail tracking link as soon as it's on its way.</p>
<p style="margin:0 0 4px;color:${MUTED};font-size:13px">ORDER NUMBER</p>
<p style="margin:0 0 12px;font-size:18px;font-weight:700">${esc(order.orderNumber)}</p>
${itemsTable(order, true)}
<p style="margin:0 0 4px;color:${MUTED};font-size:13px">DELIVERING TO</p>
<p style="margin:0 0 24px">${addressBlock(order)}</p>
${button(orderUrl, "View your order")}`,
  );
  const text = `Thanks for your order, ${order.firstName}!

Order ${order.orderNumber}
${itemsText(order)}
Delivery: ${order.shipping === 0 ? "Free" : money(order.shipping)}
Total: ${money(order.total)}

We'll email you a Royal Mail tracking link as soon as it's on its way.
View your order: ${orderUrl}`;
  return { subject: `Order confirmed — ${order.orderNumber}`, html, text };
}

export function orderShippedEmail(env: Env, order: EmailOrder) {
  const site = env.SITE_URL.replace(/\/$/, "");
  const trackUrl = order.trackingNumber ? royalMailTrackingUrl(order.trackingNumber) : null;
  const trackingHtml = trackUrl
    ? `<p style="margin:0 0 4px;color:${MUTED};font-size:13px">ROYAL MAIL TRACKING NUMBER</p>
<p style="margin:0 0 20px;font-size:18px;font-weight:700;letter-spacing:0.5px">${esc(order.trackingNumber!)}</p>
${button(trackUrl, "Track your parcel")}`
    : `<p style="margin:0 0 20px">It's travelling with Royal Mail and usually arrives within 2–4 working days.</p>
${button(`${site}/order/${order.orderNumber}`, "View your order")}`;
  const html = layout(
    env,
    `Your order ${order.orderNumber} is on its way with Royal Mail.`,
    `<h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 8px">Your books are on their way 📦</h1>
<p style="margin:0 0 16px">Good news, ${esc(order.firstName)} — order <strong>${esc(order.orderNumber)}</strong> has been dispatched with Royal Mail.</p>
${trackingHtml}
${itemsTable(order, false)}
<p style="margin:0 0 4px;color:${MUTED};font-size:13px">DELIVERING TO</p>
<p style="margin:0">${addressBlock(order)}</p>`,
  );
  const text = `Your books are on their way!

Order ${order.orderNumber} has been dispatched with Royal Mail.
${trackUrl ? `Tracking number: ${order.trackingNumber}\nTrack it: ${trackUrl}` : "It usually arrives within 2–4 working days."}

${itemsText(order)}`;
  return { subject: `Your order ${order.orderNumber} has shipped`, html, text };
}

export function reviewRequestEmail(env: Env, order: EmailOrder) {
  const site = env.SITE_URL.replace(/\/$/, "");
  const books = order.items.filter((i) => i.slug);
  const bookLinks = books
    .map(
      (i) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #eee">${esc(i.title)}</td><td align="right" style="padding:8px 0;border-bottom:1px solid #eee;white-space:nowrap"><a href="${esc(`${site}/book/${i.slug}?review=1`)}" style="color:${GREEN};font-weight:600">Rate this book →</a></td></tr>`,
    )
    .join("");
  const shopReview = env.REVIEW_URL
    ? `<p style="margin:0 0 16px">If you have a minute, a quick review of ${BRAND} helps other readers find us — it makes a real difference to a small independent shop like ours.</p>
<p style="margin:0 0 24px">${button(env.REVIEW_URL, `Review ${BRAND} ★★★★★`, AMBER)}</p>`
    : "";
  const html = layout(
    env,
    `How were your books? We'd love to hear about your ${BRAND} experience.`,
    `<h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 8px">How did we do, ${esc(order.firstName)}?</h1>
<p style="margin:0 0 16px">Your order <strong>${esc(order.orderNumber)}</strong> should have arrived by now. We hope you're enjoying your new books!</p>
${shopReview}
${bookLinks ? `<p style="margin:0 0 4px;font-weight:600">Tell other readers what you thought</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;margin:4px 0 20px">${bookLinks}</table>` : ""}
<p style="margin:0;color:${MUTED};font-size:13px">Something not right with your order? Just reply to this email and we'll sort it out.</p>`,
  );
  const text = `How did we do, ${order.firstName}?

Your order ${order.orderNumber} should have arrived by now — we hope you're enjoying your new books!
${env.REVIEW_URL ? `\nA quick review of ${BRAND} helps other readers find us: ${env.REVIEW_URL}\n` : ""}
${books.map((i) => `Rate "${i.title}": ${site}/book/${i.slug}?review=1`).join("\n")}

Something not right? Just reply to this email.`;
  return { subject: `How were your books? Tell us about your ${BRAND} order`, html, text };
}
