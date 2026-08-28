import { SignJWT, jwtVerify } from "jose";
import type { AuthUser } from "@/types/env";

const SESSION_DURATION = "7d";

export async function signSession(user: AuthUser, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({ email: user.email, name: user.name, role: user.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(SESSION_DURATION)
    .sign(key);
}

export async function verifySession(token: string, secret: string): Promise<AuthUser | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    if (typeof payload.sub !== "string") return null;
    return {
      id: payload.sub,
      email: String(payload["email"]),
      name: String(payload["name"]),
      role: payload["role"] === "admin" ? "admin" : "customer",
    };
  } catch {
    return null;
  }
}
