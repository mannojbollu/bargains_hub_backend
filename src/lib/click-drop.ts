/**
 * Minimal client for the Royal Mail Click & Drop API
 * (https://api.parcel.royalmail.com — OpenAPI spec at /swagger/v1/swagger.json).
 * Only the two calls this shop needs: create an order, and look orders up to see
 * whether a label has been printed / a tracking number assigned.
 */
const BASE_URL = "https://api.parcel.royalmail.com/api/v1";

export interface ClickDropAddress {
  fullName: string;
  addressLine1: string;
  addressLine2?: string | undefined;
  city: string;
  postcode: string;
  countryCode: string;
}

export interface ClickDropContentItem {
  name: string;
  quantity: number;
  unitValue: number;
  unitWeightInGrams: number;
}

export interface ClickDropCreateOrder {
  orderReference: string;
  recipient: { address: ClickDropAddress; phoneNumber?: string | undefined; emailAddress?: string };
  packages: {
    weightInGrams: number;
    packageFormatIdentifier: "largeLetter" | "smallParcel" | "mediumParcel";
    contents: ClickDropContentItem[];
  }[];
  orderDate: string;
  subtotal: number;
  shippingCostCharged: number;
  total: number;
  currencyCode: "GBP";
  postageDetails?: { sendNotificationsTo: "recipient"; serviceCode?: string | undefined };
}

/** Subset of GetOrderInfoResource — all timestamps are null until that step happens. */
export interface ClickDropOrderInfo {
  orderIdentifier: number;
  orderReference: string | null;
  printedOn: string | null;
  manifestedOn: string | null;
  shippedOn: string | null;
  trackingNumber: string | null;
}

export class ClickDropError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClickDropError";
  }
}

async function request<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new ClickDropError(res.status, `Click & Drop ${res.status}: ${text.slice(0, 500) || res.statusText}`);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

/** Order references are passed quoted + percent-encoded; integer ids are passed bare. */
function identifierPath(ids: (number | string)[]): string {
  return ids.map((id) => (typeof id === "number" ? String(id) : `"${encodeURIComponent(id)}"`)).join(";");
}

export async function getClickDropOrders(apiKey: string, ids: (number | string)[]): Promise<ClickDropOrderInfo[]> {
  if (ids.length === 0) return [];
  return request<ClickDropOrderInfo[]>(apiKey, `/orders/${identifierPath(ids)}`);
}

/** Looks up a single order by our own order number; null if Click & Drop doesn't have it. */
export async function findClickDropOrderByReference(apiKey: string, reference: string) {
  try {
    const [found] = await getClickDropOrders(apiKey, [reference]);
    return found ?? null;
  } catch (err) {
    if (err instanceof ClickDropError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

/** Creates one order. Returns its Click & Drop id, or throws with the validation errors. */
export async function createClickDropOrder(apiKey: string, order: ClickDropCreateOrder): Promise<number> {
  const res = await request<{
    createdOrders?: { orderIdentifier: number }[];
    failedOrders?: { errors?: { errorMessage?: string; fields?: unknown }[] }[];
  }>(apiKey, "/orders", { method: "POST", body: JSON.stringify({ items: [order] }) });

  const created = res.createdOrders?.[0];
  if (created) return created.orderIdentifier;

  const messages = (res.failedOrders?.[0]?.errors ?? [])
    .map((e) => e.errorMessage)
    .filter(Boolean)
    .join("; ");
  throw new ClickDropError(422, messages || "Click & Drop rejected the order");
}

export function royalMailTrackingUrl(trackingNumber: string): string {
  return `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(trackingNumber)}`;
}
