import { z } from "zod";
import { nonnegativeIntField, positiveIntField } from "./numeric-schemas.ts";
import { BUILTIN_GRANT_NAMES } from "./grant-registry.ts";
import { INPUT_LIMITS } from "../input-limits.ts";

export const modelField = z
  .string()
  .min(1, "model must be a non-empty string")
  .regex(
    /^[a-z0-9_-]+\/[a-zA-Z0-9_./:-]+$/,
    "model must be in the form '<provider>/<name>' (e.g. 'anthropic/claude-sonnet-4-5')",
  );

const iterationLimitField = z
  .number({ error: "iteration_limit must be a positive integer" })
  .int("iteration_limit must be a positive integer")
  .positive("iteration_limit must be a positive integer");

const modelDescription = "Provider/model string, e.g. 'anthropic/claude-sonnet-4-5'.";
const compactionPromptDescription =
  "Optional. Replaces the built-in prompt used to compact an over-budget context into a rolling " +
  "LLM summary (this prompt + the runtime-appended objective for the lead / task for the sub-agent), " +
  "using the agent's own model. Absent ⇒ the built-in prompt.";
const compactionPromptModeDescription =
  'Optional. "summarize" (the default) compacts an over-budget context into a rolling LLM ' +
  'summary. "none" disables summarization and falls back to mechanical oldest-first eviction, ' +
  "spending no tokens on compaction. Cannot be combined with compaction.prompt.";

const retrySchema = z
  .object({
    max_retries: nonnegativeIntField("retry.max_retries").optional(),
    max_retry_after_ms: positiveIntField("retry.max_retry_after_ms").optional(),
  })
  .strict();

const compactionSchema = z
  .object({
    enabled: z.boolean({ error: "compaction.enabled must be a boolean" }).optional(),
    context_fraction: z.coerce
      .number()
      .gt(0, "compaction.context_fraction must be in (0, 1]")
      .max(1, "compaction.context_fraction must be in (0, 1]")
      .optional(),
    target_fraction: z.coerce
      .number()
      .gt(0, "compaction.target_fraction must be in (0, 1]")
      .max(1, "compaction.target_fraction must be in (0, 1]")
      .optional(),
    max_result_chars: positiveIntField("compaction.max_result_chars").optional(),
    preserve_recent_tokens: nonnegativeIntField("compaction.preserve_recent_tokens").optional(),
    prompt: z
      .string()
      .min(1, "compaction.prompt must be a non-empty string")
      .max(INPUT_LIMITS.profileCompactionPromptChars)
      .optional()
      .describe(compactionPromptDescription),
    prompt_mode: z
      .enum(["summarize", "none"], {
        error: 'compaction.prompt_mode must be "summarize" or "none"',
      })
      .optional()
      .describe(compactionPromptModeDescription),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (
      c.target_fraction !== undefined &&
      c.context_fraction !== undefined &&
      c.target_fraction > c.context_fraction
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "compaction.target_fraction (compaction low-water) must be <= compaction.context_fraction (high-water)",
        path: ["target_fraction"],
      });
    }
    if (c.prompt_mode === "none" && c.prompt !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          'compaction.prompt cannot be combined with compaction.prompt_mode: "none" — the prompt would never be used',
        path: ["prompt_mode"],
      });
    }
  });

/**
 * The agent's own loop-behaviour knobs.
 *
 * @remarks `pending_task_nudges` used to live here too and no longer does. The
 * open-task nudge budget is a capability's own policy and belongs to that
 * capability's settings block, not to an agent profile. `force_tool_on_nudge`
 * stays because it is genuinely about how *this agent's loop* answers any
 * gate's nudge, whichever capability raised it.
 *
 * @remarks Unlike its siblings this block is **open**, and that is the price of
 * the move above. An agent definition is a file a person wrote by hand, and this
 * object reaches the schema verbatim from its frontmatter; `.strict()` here
 * meant that the moment a knob moved into a capability's own settings, every run
 * using an agent that still named it died at submission with an
 * unrecognized-key error rather than falling back. The engine validates the keys
 * it owns and lets a key it does not own pass — which is also what leaves room
 * for the next capability to want one here.
 */
const orchestrationSchema = z.object({
  force_tool_on_nudge: z
    .boolean({ error: "orchestration.force_tool_on_nudge must be a boolean" })
    .optional(),
});

/**
 * The syntactic schema for an agent grant.
 *
 * @remarks Semantic membership is validated against the per-run capability
 * registry after parsing. `options` remains as a built-in-only discovery aid;
 * capability-owned options come from their static grant declarations.
 */
export const grantSchema = Object.assign(
  z.string().min(1, "grants[] must each be a non-empty string").max(INPUT_LIMITS.toolNameChars),
  { options: BUILTIN_GRANT_NAMES },
);

/**
 * The complete, immutable config of one agent: identity, model, base prompt,
 * tool allow-list, capability grants, spawn topology, and per-agent
 * iteration/timeout/retry/compaction/orchestration knobs.
 *
 * @remarks Strict object; the per-field `.describe()` text is the authoritative
 *   contract for each knob (e.g. grant semantics, spawn rules,
 *   env-ceiling caps). Cross-field and env-ceiling constraints live in
 *   {@link validateBody}, not here.
 */
export const agentProfileSchema = z
  .object({
    name: z
      .string()
      .min(1, "profile name must be a non-empty string")
      .max(INPUT_LIMITS.profileNameChars)
      .describe(
        "Unique agent id referenced by entry, can_spawn, default_spawn and child-spawn tools.",
      ),
    description: z
      .string()
      .max(INPUT_LIMITS.profileDescriptionChars)
      .optional()
      .describe("Optional summary surfaced in the child-spawn tools' `profile` affordance."),
    model: modelField.describe(modelDescription),
    base_prompt: z
      .string()
      .min(1, "profile base_prompt must be a non-empty string")
      .max(INPUT_LIMITS.profileBasePromptChars)
      .optional()
      .describe(
        "Optional seed system message a spawned agent runs under; absent = seed from task.",
      ),
    tools: z
      .array(z.string().max(INPUT_LIMITS.toolNameChars))
      .max(INPUT_LIMITS.profileTools)
      .describe("Tool names (server.tool) from the pool this agent may call."),
    grants: z
      .array(grantSchema)
      .max(INPUT_LIMITS.profileGrants)
      .optional()
      .describe(
        "Capability grants for this agent. Human elicitation (only honored on the entry agent): " +
          "'ask_user' (a spawned sub-agent cannot call ask_user, so this grant on a sub-agent " +
          "profile is inert). Built-in coding " +
          "only when granted, and capped by CLARVIS_AGENT_TOOLS_MAX_GRANT): 'read_workspace' (the " +
          "read-only tools read_file/list_dir/glob/grep), 'edit_workspace' (adds the mutating file " +
          "tools write_file/edit_file/multi_edit/apply_patch; implies read), 'run_commands' (adds " +
          "the 'shell' host-command tool; implies edit). Capability-owned grants are admitted " +
          "only when that capability is registered for the run; their semantics are declared by " +
          "the owning capability rather than by this engine schema. Receiving images is not a " +
          "grant: a profile may be seeded with turn images via a child-spawn tool's `image_refs`, and is " +
          "eligible as the automatic vision delegate, exactly when its model declares the " +
          "'vision' capability.",
      ),
    can_spawn: z
      .array(z.string().max(INPUT_LIMITS.profileNameChars))
      .max(INPUT_LIMITS.profileSpawnTargets)
      .optional()
      .describe(
        "Profile names this agent may spawn (only honored on the entry agent). Non-empty = this " +
          "agent orchestrates; spawned children never inherit spawn (tree depth is bounded at 2).",
      ),
    default_spawn: z
      .string()
      .min(1, "default_spawn must be a non-empty string")
      .optional()
      .describe("Spawn target when a child-spawn tool omits `profile`; must be one of can_spawn."),
    iteration_limit: iterationLimitField
      .optional()
      .describe(
        "Per-agent iteration cap. Required on every running agent when budget.on_exceed='stop'. " +
          "For the entry agent it is the soft escalation threshold when 'escalate'; a spawned " +
          "sub-agent's iteration_limit is always a hard cap. Capped by CLARVIS_ITERATION_CEILING.",
      ),
    stagnation_threshold: nonnegativeIntField("stagnation_threshold")
      .optional()
      .describe("Identical-result count before the run is declared stagnant (0 disables)."),
    call_timeout_ms: positiveIntField("call_timeout_ms")
      .optional()
      .describe("Per-LLM-call timeout for this agent. Capped by CLARVIS_TIMEOUT_CEILING_MS."),
    reasoning_summary: z
      .enum(["off", "auto", "detailed"], {
        error: "reasoning_summary must be 'off' | 'auto' | 'detailed'",
      })
      .optional()
      .describe(
        "OpenAI reasoning summary verbosity; valid only when the model's provider is openai.",
      ),
    reasoning_effort: z
      .enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"], {
        error:
          "reasoning_effort must be 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'",
      })
      .optional()
      .describe(
        "How hard the model should reason. Mapped per provider kind: openai/openai-compatible " +
          "reasoningEffort; anthropic/google the AI SDK's standardized reasoning setting (model-aware " +
          "dispatch to a native effort/thinking-level field or a manual thinking budget), with " +
          "anthropic's 'max' tier sent as its own native effort field. Unset leaves the provider " +
          "default untouched.",
      ),
    retry: retrySchema.optional().describe("Per-agent provider retry reliability knobs."),
    compaction: compactionSchema.optional().describe("Per-agent context-compaction policy."),
    orchestration: orchestrationSchema
      .optional()
      .describe("Lead-only steering; valid only when this profile has a non-empty can_spawn."),
  })
  .strict();
