export interface Env {
  DB: D1Database;
  BUCKET?: R2Bucket;
  FRONTEND_ORIGIN: string;
  JWT_SECRET: string;
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
