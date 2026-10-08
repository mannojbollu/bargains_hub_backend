export interface Env {
  DB: D1Database;
  BUCKET?: R2Bucket;
  FRONTEND_ORIGIN: string;
  JWT_SECRET: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  // Lets the warehouse's sync job call the admin book endpoints without a browser session.
  WAREHOUSE_API_KEY: string;
  // Where this backend reports its own sales back to the warehouse, and the key it
  // authenticates with when doing so. See routes/stripe-webhook.ts.
  WAREHOUSE_WEBHOOK_URL: string;
  WAREHOUSE_WEBHOOK_KEY: string;
  // Public storefront URL, used for links inside customer emails.
  SITE_URL: string;
  // Transactional email via Resend (resend.com). The from address must be on a
  // domain verified in Resend. If RESEND_API_KEY is unset, emails are skipped.
  RESEND_API_KEY?: string;
  EMAIL_FROM: string;
  EMAIL_REPLY_TO?: string;
  // Where the review email sends people to review the shop (Trustpilot, Google
  // reviews, …). If unset, the email only links to the books on our own site.
  REVIEW_URL?: string;
  REVIEW_EMAIL_DELAY_DAYS?: string;
  // Royal Mail Click & Drop API key (Settings → Integrations → Click & Drop API).
  // If unset, paid orders aren't pushed to Click & Drop.
  CLICK_DROP_API_KEY?: string;
  // Optional Click & Drop service code to preselect on every order. Leave unset
  // to let your Click & Drop shipping rules / defaults choose the service.
  CLICK_DROP_SERVICE_CODE?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: "customer" | "admin";
}

export type Variables = {
  user: AuthUser | null;
};
