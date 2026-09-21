import { envSchema, type EnvConfig } from "@clarvis/capability";
import type { RuntimeToolPolicy } from "../runtime/tool-policy.ts";

/** Every canonical environment key has an explicit Container owner; additions fail typechecking. */
export const CONTAINER_ENV_SCOPES = {
  CLARVIS_TOKEN_CEILING: "loop",
  CLARVIS_ITERATION_CEILING: "loop",
  CLARVIS_TIMEOUT_CEILING_MS: "loop",
  CLARVIS_ESCALATION_CEILING: "loop",
  CLARVIS_RETRY_CEILING: "loop",
  CLARVIS_RETRY_AFTER_CEILING_MS: "loop",
  CLARVIS_DEFAULT_TIMEOUT_MS: "loop",
  CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT: "loop",
  CLARVIS_DEFAULT_ON_EXCEED: "loop",
  CLARVIS_DEFAULT_MAX_ESCALATIONS: "loop",
  CLARVIS_DEFAULT_ELICIT_WAIT_MS: "loop",
  CLARVIS_DEFAULT_ITERATION_LIMIT: "loop",
  CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS: "loop",
  CLARVIS_DEFAULT_STAGNATION_THRESHOLD: "loop",
  CLARVIS_DEFAULT_STAGNATION_SOFT_THRESHOLD: "loop",
  CLARVIS_GUARD_MAX_ESCALATIONS: "loop",
  CLARVIS_DEFAULT_CALL_TIMEOUT_MS: "loop",
  CLARVIS_DEFAULT_REASONING_SUMMARY: "loop",
  CLARVIS_DEFAULT_REASONING_EFFORT: "loop",
  CLARVIS_DEFAULT_MAX_RETRIES: "loop",
  CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS: "loop",
  CLARVIS_DEFAULT_COMPACTION_ENABLED: "loop",
  CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION: "loop",
  CLARVIS_DEFAULT_COMPACTION_TARGET_FRACTION: "loop",
  CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS: "loop",
  CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS: "loop",
  CLARVIS_DEFAULT_PENDING_TASK_NUDGES: "loop",
  CLARVIS_STREAM: "loop",
  CLARVIS_OWNER: "loop",
  CLARVIS_AGENT_TOOLS_ENABLED: "tools",
  CLARVIS_AGENT_TOOLS_CONFINE: "tools",
  CLARVIS_AGENT_TOOLS_MAX_GRANT: "tools",
  CLARVIS_SKILLS_ENABLED: "disabled",
  CLARVIS_HOOKS_ENABLED: "disabled",
  CLARVIS_MEMORY_TOOL_CALL_LIMIT: "loop",
  CLARVIS_MEMORY_LOCK_WARN_MS: "loop",
  CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS: "loop",
  CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS: "loop",
  CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS: "withheld",
  CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS: "withheld",
  CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION: "withheld",
  CLARVIS_LOG_LEVEL: "bootstrap",
  CLARVIS_LOG: "bootstrap",
  CLARVIS_LOG_AUDIT: "bootstrap",
  CLARVIS_MAX_PARALLEL_SUBAGENTS: "loop",
  CLARVIS_MAX_CONCURRENT_MODEL_CALLS: "model-host",
  CLARVIS_MAX_QUEUED_MODEL_CALLS: "model-host",
  CLARVIS_RUN_ABORT_SETTLE_MS: "loop",
  CLARVIS_MODEL_ABORT_SETTLE_MS: "model-host",
  CLARVIS_COMPACTION_LLM_TIMEOUT_MS: "loop",
  CLARVIS_PROVIDER_RETRY_BASE_MS: "model-host",
  CLARVIS_PROVIDER_RETRY_MAX_MS: "model-host",
  CLARVIS_PROVIDER_MAX_RESPONSE_BYTES: "model-host",
  CLARVIS_PROVIDER_MAX_SSE_EVENT_BYTES: "model-host",
  CLARVIS_MCP_SERVER_STDERR: "withheld",
  CLARVIS_MCP_SERVER_STDERR_MAX_BYTES: "withheld",
  CLARVIS_MCP_CONNECT_TIMEOUT_MS: "withheld",
  CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS: "withheld",
  CLARVIS_MCP_POOL_IDLE_TTL_MS: "withheld",
  CLARVIS_MCP_STDIO_MAX_FRAME_BYTES: "withheld",
  CLARVIS_MCP_HTTP_MAX_RESPONSE_BYTES: "withheld",
  CLARVIS_MCP_HTTP_MAX_SSE_EVENT_BYTES: "withheld",
  CLARVIS_MCP_MAX_SERVERS_PER_RUN: "withheld",
  CLARVIS_MCP_MAX_CONNECTIONS: "withheld",
  CLARVIS_MCP_MAX_PARALLEL_CONNECTS: "withheld",
  CLARVIS_MCP_MAX_IDLE_CONNECTIONS: "withheld",
  CLARVIS_MCP_TIMEOUT_STREAK_THRESHOLD: "withheld",
  CLARVIS_MCP_HEALTH_PING_INTERVAL_MS: "withheld",
  CLARVIS_MCP_RESOURCES: "withheld",
  CLARVIS_MCP_POOL_SHARING: "withheld",
  CLARVIS_TRACE_TTL_DAYS: "loop",
  CLARVIS_TRACE_CLEANUP_INTERVAL_MS: "loop",
  CLARVIS_TRACE_CLEANUP_BATCH_SIZE: "loop",
} as const satisfies Record<
  keyof EnvConfig,
  "loop" | "tools" | "bootstrap" | "withheld" | "disabled" | "model-host"
>;

type LoopKey = {
  [K in keyof typeof CONTAINER_ENV_SCOPES]: (typeof CONTAINER_ENV_SCOPES)[K] extends
    "loop" | "disabled"
    ? K
    : never;
}[keyof typeof CONTAINER_ENV_SCOPES];
/** Typed, transport-free loop policy. Model concurrency and transport limits remain host-owned. */
export type ContainerLoopPolicy = Readonly<Pick<EnvConfig, LoopKey>>;
const keys = (Object.keys(CONTAINER_ENV_SCOPES) as Array<keyof EnvConfig>).filter(
  (key): key is LoopKey =>
    CONTAINER_ENV_SCOPES[key] === "loop" || CONTAINER_ENV_SCOPES[key] === "disabled",
);
/** Copy only admitted resolved values; extension switches cannot be inherited. */
export function projectContainerLoopPolicy(env: EnvConfig): ContainerLoopPolicy {
  return Object.freeze(
    Object.fromEntries(
      keys.flatMap((key) => {
        const value = CONTAINER_ENV_SCOPES[key] === "disabled" ? false : env[key];
        return value === undefined ? [] : [[key, value]];
      }),
    ),
  ) as ContainerLoopPolicy;
}
/** Reject coercion, missing defaults, unknown keys and cross-field ceiling violations. */
export function validContainerLoopPolicy(value: unknown): value is ContainerLoopPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Partial<ContainerLoopPolicy>;
  if (Object.keys(input).some((key) => !keys.includes(key as LoopKey))) return false;
  const parsed = envSchema.safeParse(input);
  return (
    parsed.success &&
    keys.every((key) => Object.is(input[key], parsed.data[key])) &&
    input.CLARVIS_SKILLS_ENABLED === false &&
    input.CLARVIS_HOOKS_ENABLED === false
  );
}
/** Reconstitute native defaults without reading process.env; logging belongs to bootstrap. */
export function containerLoopEnvironment(
  policy: ContainerLoopPolicy,
  tools: RuntimeToolPolicy,
): EnvConfig {
  if (!validContainerLoopPolicy(policy)) throw new Error("Invalid Container loop policy");
  return Object.freeze(
    envSchema.parse({
      ...policy,
      CLARVIS_AGENT_TOOLS_ENABLED: tools.enabled,
      CLARVIS_AGENT_TOOLS_CONFINE: tools.confine,
      CLARVIS_AGENT_TOOLS_MAX_GRANT: tools.maxGrant,
      CLARVIS_LOG_LEVEL: "silent",
      CLARVIS_LOG_AUDIT: false,
    }),
  );
}
