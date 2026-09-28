import type { SubscriptionScheme } from "@clarvis/protocol";

/** Complete subscription vocabulary, independent of available registrations. */
const schemeCatalog = {
  "openai-codex": true,
  "xai-grok": true,
} as const satisfies Record<SubscriptionScheme, true>;

/** Subscription schemes in their stable presentation order. */
export const SUBSCRIPTION_SCHEMES: readonly SubscriptionScheme[] = Object.keys(
  schemeCatalog,
) as (keyof typeof schemeCatalog)[];
