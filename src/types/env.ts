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
