import { SignJWT, jwtVerify } from "jose";

const SESSION_DURATION = "7d";

// Deliberately carries only the user id, nothing else. Authorization-relevant
// fields (role, above all) are never trusted from the token — attachUser
// re-reads the current row from the database on every request instead, so
// revoking/changing a user's role takes effect immediately rather than only
// once their existing session expires (up to 7 days later).
export async function signSession(userId: string, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret);
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(SESSION_DURATION)
    .sign(key);
}

/** Verifies the token's signature/expiry and returns the user id it was issued for. */
export async function verifySessionUserId(token: string, secret: string): Promise<string | null> {
  try {
    const key = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, key);
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}
