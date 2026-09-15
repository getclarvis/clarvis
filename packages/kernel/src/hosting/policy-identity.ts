import { createHash } from "node:crypto";
import type { EnvConfig } from "@clarvis/capability";
import { runtimeLoopPolicy } from "../runtime/loop-policy.ts";

/**
 * Identify effective operator execution policy without hashing credentials or arbitrary environment
 * values. Equivalent boolean/numeric spellings share an identity; either widening or narrowing
 * requires a fresh host after an explicit idle restart.
 */
export function localKernelPolicyIdentity(env: EnvConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        loop: runtimeLoopPolicy(env),
        tools: {
          enabled: env.CLARVIS_AGENT_TOOLS_ENABLED,
          confine: env.CLARVIS_AGENT_TOOLS_CONFINE,
          maxGrant: env.CLARVIS_AGENT_TOOLS_MAX_GRANT,
        },
      }),
    )
    .digest("hex");
}
