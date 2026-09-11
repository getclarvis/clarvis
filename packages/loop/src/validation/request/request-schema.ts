import { z } from "zod";
import type {
  AgentProfile,
  McpServerConfig,
  ProviderConfig,
  RunRequest,
} from "@clarvis/capability";
import { capabilityRequestParamFields } from "../../runtime/capabilities/settings-specs.ts";
import {
  EXECUTION_ID_MAX,
  EXECUTION_ID_MIN,
  EXECUTION_ID_PATTERN,
} from "../../types/execution-id.ts";
import { messagesField } from "./message-schemas.ts";
import { nonnegativeIntField } from "./numeric-schemas.ts";
import { INPUT_LIMITS } from "../input-limits.ts";
import { agentProfileSchema, modelField } from "./profile-schemas.ts";
import { providerConfigSchema } from "./provider-schemas.ts";
import { serverSchema } from "./server-schemas.ts";

const executionIdField = z
  .string()
  .min(EXECUTION_ID_MIN, "execution_id must be 1–128 characters")
  .max(EXECUTION_ID_MAX, "execution_id must be 1–128 characters")
  .regex(EXECUTION_ID_PATTERN, "execution_id may contain only letters, digits, '.', '_', ':', '-'")
  .optional()
  .describe("Optional caller-provided execution ID.");

/** Canonical persisted identity component; the composed key is validated before inference. */
const cacheIdentityField = z
  .string()
  .regex(/^[A-Za-z0-9._:-]+$/)
  .max(510)
  .optional();

/**
 * Optional per-run lifetime for a written prompt-cache prefix.
 *
 * @remarks Defaults to `"1h"` when the run can park on a human long enough for a
 *   five-minute entry to expire (see `humanParkLikely` on {@link RunShape}), and
 *   to `"5m"` otherwise. `"5m"` emits Anthropic's default and leaves the request
 *   body byte-identical to a run that never set the field.
 */
const promptCacheTtlField = z
  .enum(["5m", "1h"])
  .optional()
  .describe(
    "Optional lifetime for a written prompt-cache prefix (Anthropic). '5m' is the provider " +
      "default and costs 1.25x base input to write; '1h' costs 2x but survives a long human " +
      "pause, so a cached prefix is still readable after an approval or guard confirmation. " +
      "Omit to let the run derive it: '1h' when an ask_user grant or a capability that reaches the human can " +
      "park the run on a human, '5m' otherwise.",
  );

/**
 * Optional `execution_id` of a prior run to seed context from (same id shape as
 * {@link executionIdField}).
 *
 * @remarks When set, `messages` carries only the new turn; the run fails with
 *   `continuation_unavailable` if no stored context exists for that id.
 */
const continueFromField = z
  .string()
  .min(EXECUTION_ID_MIN, "continue_from must be 1–128 characters")
  .max(EXECUTION_ID_MAX, "continue_from must be 1–128 characters")
  .regex(EXECUTION_ID_PATTERN, "continue_from may contain only letters, digits, '.', '_', ':', '-'")
  .optional()
  .describe(
    "execution_id of a prior run to continue from: the run seeds from that run's persisted " +
      "context, so messages carries only the new turn. Fails with 'continuation_unavailable' " +
      "when no stored context exists.",
  );

/**
 * The run's spend limits and what happens at the boundary: `on_exceed`
 * (`stop` = hard wall, `escalate` = soft threshold that asks the user), an
 * optional cumulative `total_token_limit`, `timeout_ms`, and `max_escalations`.
 *
 * @remarks Strict object. Which of the optional bounds is required depends on
 *   `on_exceed`; that cross-field rule is enforced in {@link validateBody}
 *   ({@link enforceBudgetMode}), not by this schema.
 */
export const budgetSchema = z
  .object({
    on_exceed: z
      .enum(["stop", "escalate"], {
        error: "budget.on_exceed must be 'stop' | 'escalate'",
      })
      .describe(
        "What happens when a limit is reached: 'stop' = hard wall (run ends); 'escalate' = " +
          "the limit is a soft threshold that asks the user whether to continue.",
      ),
    total_token_limit: z
      .number({ error: "total_token_limit must be a positive integer" })
      .int("total_token_limit must be a positive integer")
      .positive("total_token_limit must be a positive integer")
      .optional()
      .describe(
        "Cumulative input+output token spend across the whole run (NOT a per-call output cap). " +
          "Required when on_exceed='stop'; the soft escalation threshold when 'escalate'.",
      ),
    timeout_ms: z
      .number({ error: "timeout_ms must be a positive integer" })
      .int("timeout_ms must be a positive integer")
      .positive("timeout_ms must be a positive integer")
      .optional(),
    max_escalations: z
      .number({ error: "max_escalations must be a positive integer" })
      .int("max_escalations must be a positive integer")
      .positive("max_escalations must be a positive integer")
      .optional(),
  })
  .strict();

/**
 * Optional JSON Schema for a structured run result; passed through opaquely here
 * (`z.unknown`) and validated for well-formedness separately.
 *
 * @remarks When present, a `submit_result` tool is injected into the finalizing
 *   agent and the run result becomes the validated submission; a malformed
 *   schema is rejected pre-execution with `invalid_output_schema`. Well-formedness
 *   is checked with {@link createStrictAjv}, not by Zod.
 */
const outputSchemaField = z
  .unknown()
  .optional()
  .meta({
    type: "object",
    description:
      "Optional JSON Schema describing the desired structured result. " +
      "When present, a 'submit_result' tool is injected into the finalizing agent and " +
      "the run result is the validated submission (else free text). Well-formedness is " +
      "validated pre-execution; a malformed schema is rejected with 'invalid_output_schema'.",
  });

/**
 * The full, strict schema for a run request body: identity/continuation fields,
 * `messages`, MCP `servers`, agent `profiles` + `entry`, `providers`, `budget`,
 * elicitation wait, `output_schema`, and every capability's request-param fields.
 *
 * @remarks Structural (shape/type) validation only; cross-field, uniqueness, and
 *   env-ceiling rules are applied afterward by {@link validateBody}. Capability
 *   params are spread in from {@link capabilityRequestParamFields}, and the
 *   `_*DriftLock` compile-time guards below assert this schema's inferred type
 *   stays in sync with the hand-written {@link RunRequest} DTOs.
 */
export const runRequestSchema = z
  .object({
    execution_id: executionIdField,
    continue_from: continueFromField,
    session_id: cacheIdentityField,
    agent_instance_id: cacheIdentityField,
    prompt_cache_ttl: promptCacheTtlField,
    messages: messagesField,
    servers: z
      .array(serverSchema, {
        error: "servers must be an array (may be empty)",
      })
      .max(1_000, "servers must contain at most 1000 entries")
      .describe(
        "MCP server descriptors. Each is an MCP server the agents use — over stdio (a spawned " +
          "subprocess, default) or the network (http = Streamable HTTP, or sse).",
      ),
    profiles: z
      .array(agentProfileSchema, { error: "profiles must contain at least one entry" })
      .min(1, "profiles must contain at least one entry")
      .max(1_000, "profiles must contain at most 1000 entries")
      .describe(
        "Agent profiles — the complete, immutable config of each agent (model, base prompt, " +
          "tools, capability grants, iteration limits, compaction). One is named by `entry` as the " +
          "root; an agent with a non-empty can_spawn orchestrates and spawns the others.",
      ),
    entry: z
      .string()
      .min(1, "entry must be a non-empty string")
      .describe(
        "Name of the root profile the run starts on. An entry with a non-empty can_spawn runs as " +
          "the orchestrator (Lead+Sub-agent); otherwise it runs solo (Sub-agent-only).",
      ),
    shared_prompt: z
      .string()
      .max(INPUT_LIMITS.systemPromptChars)
      .optional()
      .describe(
        "Fleet-wide shared prompt injected ahead of every profile prompt. Omit to use the " +
          "engine default; an empty string disables the shared layer.",
      ),
    providers: z
      .array(providerConfigSchema)
      .min(1, "providers must contain at least one entry")
      .max(1_000, "providers must contain at most 1000 entries")
      .describe(
        "Named provider instances (endpoint + credential NAME) the model strings reference by " +
          "their provider token. Required: every profile's model token MUST match a providers[].name " +
          "— there are no built-in providers; an undeclared token is rejected (unknown_provider). The " +
          "Lead/Sub-agent/profiles may use DIFFERENT providers in one run. Keys are env-only: " +
          "api_key_env is the NAME of an env var the runtime reads, never a key value.",
      ),
    vision_model: modelField
      .optional()
      .describe(
        "Model used to read the turn's images when the entry agent's own model lacks the " +
          "'vision' capability. The pass is a single completion with no tools and no workspace: " +
          "its reading is spliced into the entry agent's context as an '[image analysis]' " +
          "message. Omit to leave images as numbered placeholders for a model that cannot see.",
      ),
    budget: budgetSchema,
    elicit_wait_ms: nonnegativeIntField("elicit_wait_ms")
      .optional()
      .describe("How long to wait for a human elicitation reply (0 = never block on a human)."),
    guard_escalation: z
      .boolean({ error: "guard_escalation must be a boolean" })
      .optional()
      .describe(
        "When true, a convergence guard trip asks the user whether to continue instead of " +
          "ending the run outright. Requires an elicitation channel. Off by default, so a " +
          "caller that never sees the question is never held up by it.",
      ),
    output_schema: outputSchemaField,
    ...capabilityRequestParamFields,
  })
  .strict();

/** The type inferred from {@link runRequestSchema} — a structurally-valid request, before {@link validateBody}'s semantic checks. */
export type ParsedRunRequest = z.infer<typeof runRequestSchema>;

/**
 * Compile-time drift guards: each `_*DriftLock` constant only type-checks while
 * the schema's inferred type and its hand-written DTO remain mutually assignable
 * with identical top-level keys, so a schema/DTO divergence breaks the build.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type SameTopLevelKeys<A, B> = [Exclude<keyof A, keyof B>] extends [never]
  ? [Exclude<keyof B, keyof A>] extends [never]
    ? true
    : false
  : false;
type SchemaMatches<A, B> = MutuallyAssignable<A, B> extends true ? SameTopLevelKeys<A, B> : false;

const _runRequestDriftLock: SchemaMatches<ParsedRunRequest, RunRequest> = true;
const _agentProfileDriftLock: SchemaMatches<
  z.infer<typeof agentProfileSchema>,
  AgentProfile
> = true;
const _serverConfigDriftLock: SchemaMatches<z.infer<typeof serverSchema>, McpServerConfig> = true;
const _providerConfigDriftLock: SchemaMatches<
  z.infer<typeof providerConfigSchema>,
  ProviderConfig
> = true;
void _runRequestDriftLock;
void _agentProfileDriftLock;
void _serverConfigDriftLock;
void _providerConfigDriftLock;
