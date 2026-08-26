import type { SubscriptionDiagnostic } from "@clarvis/protocol";

/** Stable internal error that never retains an OAuth response body or credential-bearing URL. */
export class SubscriptionError extends Error {
  constructor(
    readonly code:
      | "subscription_unavailable"
      | "subscription_login_required"
      | "subscription_login_failed"
      | "subscription_reauthentication_required"
      | "subscription_entitlement_denied"
      | "subscription_quota_exhausted"
      | "subscription_transport_refused"
      | "subscription_in_use",
    message: string,
    readonly diagnostic?: SubscriptionDiagnostic,
  ) {
    super(message);
    this.name = "SubscriptionError";
  }
}

/** Project an untrusted provider failure into the closed UI diagnostic vocabulary. */
export function subscriptionDiagnostic(error: unknown): SubscriptionDiagnostic {
  if (error instanceof SubscriptionError && error.diagnostic !== undefined) return error.diagnostic;
  return "network";
}
