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
 * Compose the session and persisted agent instance without truncation or collisions.
 *
 * @remarks Underscores within a component are escaped as `%5F`, leaving exactly one
 * separator. Percent signs are not admitted in raw components. The resulting ASCII
 * key is at most 512 characters. Profiles, iterations and physical retries do not
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
  return key;
}
