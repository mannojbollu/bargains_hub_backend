import bcrypt from "bcryptjs";

// Cost factor 10 balances security and Workers CPU-time limits — bcryptjs is pure
// JS (no native bindings), so it's the part of signup/login that costs the most CPU.
const COST_FACTOR = 10;

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, COST_FACTOR);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
