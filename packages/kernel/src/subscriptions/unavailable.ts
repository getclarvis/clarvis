import type { ProviderAuthService, SubscriptionAccountStatus } from "@clarvis/protocol";

import { SubscriptionError } from "./redaction.ts";
import { SUBSCRIPTION_SCHEMES } from "./schemes.ts";

/** Explicit remote/build-disabled subscription service; it never starts an authorization flow. */
export function createUnavailableProviderAuthService(): ProviderAuthService {
  return {
    async list(): Promise<SubscriptionAccountStatus[]> {
      return SUBSCRIPTION_SCHEMES.map((scheme) => ({
        scheme,
        state: "unavailable",
        authorization_available: false,
        diagnostic: "not_authorized",
      }));
    },
    async startDevice(): Promise<never> {
      throw new SubscriptionError(
        "subscription_unavailable",
        "Subscription billing is not available in this Clarvis host.",
        "not_authorized",
      );
    },
    async wait(): Promise<never> {
      throw new SubscriptionError(
        "subscription_login_failed",
        "The subscription login attempt is not available.",
      );
    },
    async cancel(): Promise<void> {},
    async disconnect(): Promise<void> {},
  };
}
