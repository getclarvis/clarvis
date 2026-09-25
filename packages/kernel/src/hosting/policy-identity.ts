import { createHash } from "node:crypto";
import type { EnvConfig } from "@clarvis/capability";

const hostOnlyEnvironmentKeys = new Set<keyof EnvConfig>([
  "CLARVIS_OWNER",
  "CLARVIS_LOG_LEVEL",
  "CLARVIS_LOG",
  "CLARVIS_LOG_AUDIT",
  "CLARVIS_MEMORY_LOCK_WARN_MS",
  "CLARVIS_TRACE_TTL_DAYS",
  "CLARVIS_TRACE_CLEANUP_INTERVAL_MS",
  "CLARVIS_TRACE_CLEANUP_BATCH_SIZE",
]);

/**
 * Identify effective operator execution policy without hashing credentials or arbitrary
 * environment values. Equivalent boolean/numeric spellings share an identity.
 */
export function localKernelPolicyIdentity(env: EnvConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        loop: Object.fromEntries(
          Object.entries(env).filter(
            ([key]) => !hostOnlyEnvironmentKeys.has(key as keyof EnvConfig),
          ),
        ),
        tools: {
          enabled: env.CLARVIS_AGENT_TOOLS_ENABLED,
          maxGrant: env.CLARVIS_AGENT_TOOLS_MAX_GRANT,
        },
      }),
    )
    .digest("hex");
}

/** Read the same operator execution policy on the launcher and lease-owning host. */
export function localHostPolicyIdentity(input: { env: EnvConfig }): string {
  return localKernelPolicyIdentity(input.env);
}
