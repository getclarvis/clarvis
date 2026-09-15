import { envSchema, type EnvConfig } from "@clarvis/capability";
import type { RuntimeToolPolicy } from "./tool-policy.ts";

/**
 * Exhaustively classify canonical configuration before admitting it to the private worker.
 * Host identity, diagnostics and retention never cross this boundary; tool authority has its
 * own capability-aware snapshot. New environment fields require an explicit ownership decision.
 */
const policyScopes = {
  CLARVIS_TOKEN_CEILING: "guest",
  CLARVIS_ITERATION_CEILING: "guest",
  CLARVIS_TIMEOUT_CEILING_MS: "guest",
  CLARVIS_ESCALATION_CEILING: "guest",
  CLARVIS_RETRY_CEILING: "guest",
  CLARVIS_RETRY_AFTER_CEILING_MS: "guest",
  CLARVIS_DEFAULT_TIMEOUT_MS: "guest",
  CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT: "guest",
  CLARVIS_DEFAULT_ON_EXCEED: "guest",
  CLARVIS_DEFAULT_MAX_ESCALATIONS: "guest",
  CLARVIS_DEFAULT_ELICIT_WAIT_MS: "guest",
  CLARVIS_DEFAULT_ITERATION_LIMIT: "guest",
  CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS: "guest",
  CLARVIS_DEFAULT_STAGNATION_THRESHOLD: "guest",
  CLARVIS_DEFAULT_STAGNATION_SOFT_THRESHOLD: "guest",
  CLARVIS_GUARD_MAX_ESCALATIONS: "guest",
  CLARVIS_DEFAULT_CALL_TIMEOUT_MS: "guest",
  CLARVIS_DEFAULT_REASONING_SUMMARY: "guest",
  CLARVIS_DEFAULT_REASONING_EFFORT: "guest",
  CLARVIS_DEFAULT_MAX_RETRIES: "guest",
  CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS: "guest",
  CLARVIS_DEFAULT_COMPACTION_ENABLED: "guest",
  CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION: "guest",
  CLARVIS_DEFAULT_COMPACTION_TARGET_FRACTION: "guest",
  CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS: "guest",
  CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS: "guest",
  CLARVIS_DEFAULT_FORCE_TOOL_ON_NUDGE: "guest",
  CLARVIS_DEFAULT_PENDING_TASK_NUDGES: "guest",
  CLARVIS_STREAM: "guest",
  CLARVIS_OWNER: "host",
  CLARVIS_AGENT_TOOLS_ENABLED: "tools",
  CLARVIS_AGENT_TOOLS_CONFINE: "tools",
  CLARVIS_AGENT_TOOLS_MAX_GRANT: "tools",
  CLARVIS_SKILLS_ENABLED: "guest",
  CLARVIS_HOOKS_ENABLED: "guest",
  CLARVIS_MEMORY_TOOL_CALL_LIMIT: "guest",
  CLARVIS_MEMORY_LOCK_WARN_MS: "host",
  CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS: "guest",
  CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS: "guest",
  CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS: "guest",
  CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS: "guest",
  CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION: "guest",
  CLARVIS_LOG_LEVEL: "host",
  CLARVIS_LOG: "host",
  CLARVIS_LOG_AUDIT: "host",
  CLARVIS_MAX_PARALLEL_SUBAGENTS: "guest",
  CLARVIS_MAX_CONCURRENT_MODEL_CALLS: "guest",
  CLARVIS_MAX_QUEUED_MODEL_CALLS: "guest",
  CLARVIS_RUN_ABORT_SETTLE_MS: "guest",
  CLARVIS_MODEL_ABORT_SETTLE_MS: "guest",
  CLARVIS_COMPACTION_LLM_TIMEOUT_MS: "guest",
  CLARVIS_PROVIDER_RETRY_BASE_MS: "guest",
  CLARVIS_PROVIDER_RETRY_MAX_MS: "guest",
  CLARVIS_PROVIDER_MAX_RESPONSE_BYTES: "guest",
  CLARVIS_PROVIDER_MAX_SSE_EVENT_BYTES: "guest",
  CLARVIS_MCP_SERVER_STDERR: "guest",
  CLARVIS_MCP_SERVER_STDERR_MAX_BYTES: "guest",
  CLARVIS_MCP_CONNECT_TIMEOUT_MS: "guest",
  CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS: "guest",
  CLARVIS_MCP_POOL_IDLE_TTL_MS: "guest",
  CLARVIS_MCP_STDIO_MAX_FRAME_BYTES: "guest",
  CLARVIS_MCP_HTTP_MAX_RESPONSE_BYTES: "guest",
  CLARVIS_MCP_HTTP_MAX_SSE_EVENT_BYTES: "guest",
  CLARVIS_MCP_MAX_SERVERS_PER_RUN: "guest",
  CLARVIS_MCP_MAX_CONNECTIONS: "guest",
  CLARVIS_MCP_MAX_PARALLEL_CONNECTS: "guest",
  CLARVIS_MCP_MAX_IDLE_CONNECTIONS: "guest",
  CLARVIS_MCP_TIMEOUT_STREAK_THRESHOLD: "guest",
  CLARVIS_MCP_HEALTH_PING_INTERVAL_MS: "guest",
  CLARVIS_MCP_RESOURCES: "guest",
  CLARVIS_MCP_POOL_SHARING: "guest",
  CLARVIS_TRACE_TTL_DAYS: "host",
  CLARVIS_TRACE_CLEANUP_INTERVAL_MS: "host",
  CLARVIS_TRACE_CLEANUP_BATCH_SIZE: "host",
} as const satisfies Record<keyof EnvConfig, "guest" | "tools" | "host">;

type GuestPolicyKey = {
  [K in keyof typeof policyScopes]: (typeof policyScopes)[K] extends "guest" ? K : never;
}[keyof typeof policyScopes];

/** Resolved non-secret defaults and ceilings consumed by the isolated execution loop. */
export type RuntimeLoopPolicy = Readonly<Pick<EnvConfig, GuestPolicyKey>>;

const guestKeys = (Object.keys(policyScopes) as Array<keyof typeof policyScopes>).filter(
  (key): key is GuestPolicyKey => policyScopes[key] === "guest",
);

/** Snapshot only explicitly admitted resolved values, retaining optional-field absence. */
export function runtimeLoopPolicy(env: EnvConfig): RuntimeLoopPolicy {
  return Object.freeze(
    Object.fromEntries(
      guestKeys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]]),
    ),
  ) as RuntimeLoopPolicy;
}

/**
 * Reuse canonical cross-field validation while refusing missing defaults, coercion, unknown keys
 * and host-owned strings. The wire carries resolved policy, never raw environment input.
 */
export function validRuntimeLoopPolicy(value: unknown): value is RuntimeLoopPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !guestKeys.includes(key as GuestPolicyKey))) return false;
  const parsed = envSchema.safeParse(input);
  return parsed.success && guestKeys.every((key) => Object.is(input[key], parsed.data[key]));
}

/** Restore canonical loop configuration with separately admitted tool authority and quiet logging. */
export function guestLoopEnvironment(
  policy: RuntimeLoopPolicy,
  tools: RuntimeToolPolicy,
): EnvConfig {
  return Object.freeze(
    envSchema.parse({
      ...policy,
      CLARVIS_AGENT_TOOLS_ENABLED: tools.enabled,
      CLARVIS_AGENT_TOOLS_CONFINE: tools.confine,
      CLARVIS_AGENT_TOOLS_MAX_GRANT: tools.maxGrant,
      CLARVIS_LOG_LEVEL: "silent",
    }),
  );
}
