export function newId(): string {
  return crypto.randomUUID();
}

export function newOrderNumber(): string {
  const n = Math.floor(100000 + Math.random() * 900000);
  return `BNB-${n}`;
}
