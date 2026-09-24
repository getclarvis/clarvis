import { createHash } from "node:crypto";
import type { EnvConfig } from "@clarvis/capability";
import type { ResolvedSandboxSettings } from "@clarvis/loop/host";
import { createFileConfigStore } from "../config/file-config-store.ts";
import { createSandboxPolicyResolver } from "../sandbox/policy.ts";

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
 * Identify effective operator execution policy, including the resolved Sandbox snapshot, without
 * hashing credentials or arbitrary environment values. Equivalent boolean/numeric spellings share
 * an identity; either widening or narrowing requires a fresh host after an explicit idle restart.
 */
export function localKernelPolicyIdentity(
  env: EnvConfig,
  sandbox?: ResolvedSandboxSettings,
): string {
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
        sandbox: sandbox?.enabled === false ? null : (sandbox ?? null),
      }),
    )
    .digest("hex");
}

/** Read the same effective Sandbox settings on the launcher and lease-owning host. */
export function localHostPolicyIdentity(input: {
  env: EnvConfig;
  workspaceRoot: string;
  globalDir: string;
  environment: Readonly<Record<string, string | undefined>>;
}): string {
  const store = createFileConfigStore({
    workspaceRoot: input.workspaceRoot,
    globalDir: input.globalDir,
  });
  const sandbox = createSandboxPolicyResolver(
    store,
    input.workspaceRoot,
    input.environment,
  ).resolve();
  return localKernelPolicyIdentity(input.env, sandbox);
}
