import Stripe from "stripe";

// Workers has no Node net/tls stack — Stripe's SDK needs the fetch-based HTTP
// client explicitly, and webhook signature verification needs the SubtleCrypto
// provider (constructEventAsync) instead of the default Node crypto path.
export function getStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

export function getStripeCryptoProvider() {
  return Stripe.createSubtleCryptoProvider();
}
