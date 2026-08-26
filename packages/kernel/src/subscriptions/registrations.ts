import type { SubscriptionScheme } from "@clarvis/protocol";

import type { SubscriptionSchemeRegistration } from "./types.ts";

/**
 * Project-approved public-client registrations for subscription-backed local providers.
 *
 * @remarks These identifiers are public OAuth client identifiers, not secrets. Provider-owned and
 * independent OSS clients publish them. The project owner explicitly accepts reuse of these public
 * references for Clarvis; this records a Clarvis product decision, not provider endorsement.
 * Endpoints remain pinned here and cannot be redirected by settings.
 */
const SUBSCRIPTION_SCHEME_REGISTRATIONS: Readonly<
  Partial<Record<SubscriptionScheme, SubscriptionSchemeRegistration>>
> = Object.freeze({
  "openai-codex": Object.freeze({
    scheme: "openai-codex",
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    issuer: "https://auth.openai.com",
    transportOrigin: "https://chatgpt.com",
    authorization: Object.freeze({
      owner: "project-owner-approved-public-reference",
      evidence:
        "Project-owner decision on 2026-08-24; public protocol reference: https://github.com/openai/codex/tree/main/codex-rs/login",
    }),
  }),
  "xai-grok": Object.freeze({
    scheme: "xai-grok",
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    issuer: "https://auth.x.ai",
    transportOrigin: "https://cli-chat-proxy.grok.com",
    authorization: Object.freeze({
      owner: "project-owner-approved-public-reference",
      evidence:
        "Project-owner decision on 2026-08-24; public protocol reference: https://github.com/xai-org/grok-build",
    }),
  }),
});

/** Resolve one immutable production registration unless it remains only an unapproved reference. */
export function subscriptionRegistration(
  scheme: SubscriptionScheme,
): SubscriptionSchemeRegistration | undefined {
  const registration = SUBSCRIPTION_SCHEME_REGISTRATIONS[scheme];
  return registration?.authorization.owner === "public-oss-reference" ? undefined : registration;
}
