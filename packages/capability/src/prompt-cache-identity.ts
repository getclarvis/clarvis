import { createHash } from "node:crypto";

/** Persisted identities of one conversation and one agent instance within it. */
export interface PromptCacheIdentity {
  readonly sessionId: string;
  readonly agentInstanceId: string;
}

/** Canonical identity components admit the persisted execution-ID ASCII alphabet. */
export function isPromptCacheIdentityComponent(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]+$/.test(value);
}

/**
 * Compose a stable session/instance affinity key within provider wire limits.
 *
 * @remarks Underscores within a component are escaped as `%5F`, leaving exactly one
 * separator. Percent signs are not admitted in raw components. A composed key
 * longer than 64 characters is SHA-256 encoded as 64 lowercase hex characters;
 * shorter keys retain their readable form. Raw composed keys always contain
 * the separator, so they cannot equal a hashed key. Inputs remain bounded at
 * 512 composed characters. Profiles, iterations and physical retries do not
 * participate in identity, and this function never creates an identifier.
 */
export function composePromptCacheKey(identity: PromptCacheIdentity): string {
  if (
    !isPromptCacheIdentityComponent(identity.sessionId) ||
    !isPromptCacheIdentityComponent(identity.agentInstanceId)
  ) {
    throw new RangeError(
      "Prompt-cache identity components must be canonical nonempty ASCII identifiers",
    );
  }
  const key = `${identity.sessionId.replaceAll("_", "%5F")}_${identity.agentInstanceId.replaceAll("_", "%5F")}`;
  if (key.length > 512)
    throw new RangeError("Composed prompt-cache identity exceeds 512 characters");
  return key.length <= 64 ? key : createHash("sha256").update(key).digest("hex");
}
