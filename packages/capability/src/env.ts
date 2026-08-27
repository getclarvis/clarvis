import { z } from "zod";

import { DEFAULT_LOG_LEVEL, LOG_LEVELS } from "./log.ts";

/**
 * How many times an agent is nudged about tasks still open on its plan before
 * the finalization gate stops asking.
 *
 * @remarks Duplicated deliberately. The authoritative value belongs to the plans
 *   capability (`PLANS_DEFAULTS.pending_task_nudges` in `@clarvis/plan`), and
 *   importing it here would give this package — the dependency-free contract
 *   leaf — an edge to a capability that is built on top of it. A drift test in
 *   `@clarvis/plan` asserts the two never disagree, the same arrangement that
 *   already holds between `DEFAULT_PLAN_RETENTION` and `PLANS_DEFAULTS`.
 *
 *   Three because the nudges are *consecutive stalls*, not reminders: the first
 *   tells the agent something it may not have noticed, the second establishes it
 *   is not acting on it, and the third distinguishes a model working slowly from
 *   one that has stopped. Below that the gate gives up while the agent may still
 *   be converging; above it, the gate is asking a question that has been ignored
 *   three times.
 */
export const DEFAULT_PENDING_TASK_NUDGES = 3;

const positiveInt = z.coerce.number().int().positive();
const nonnegativeInt = z.coerce.number().int().nonnegative();

/**
 * Build a zod schema that coerces an environment value into a boolean.
 *
 * @param def - the value used when the variable is absent (`undefined`).
 * @returns a schema that treats `"false"`, `"0"`, `"no"`, `"off"` and the empty
 *   string (case-insensitive, trimmed) as `false` and any other string as
 *   `true`; non-string values fall back to `Boolean(v)`.
 * @remarks The false-value list is a decision that can drift between hosts, so
 *   this is the one authoritative source; `@clarvis/server`'s `loadServerEnv`
 *   imports it rather than keeping its own copy. `positiveInt`/`nonnegativeInt`
 *   stay unexported and duplicated in each host on purpose - they are zod idiom
 *   with exactly one correct spelling, and extracting them would widen this
 *   package's public surface to save one line each.
 */
export const boolFromEnv = (def: boolean) =>
  z.preprocess(
    (v) =>
      v === undefined
        ? def
        : typeof v === "string"
          ? !["false", "0", "no", "off", ""].includes(v.trim().toLowerCase())
          : Boolean(v),
    z.boolean(),
  );

const reasoningSummary = z.enum(["off", "auto", "detailed"]);
const reasoningEffort = z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

const baseEnvSchema = z.object({
  CLARVIS_TOKEN_CEILING: positiveInt.default(200_000_000),
  CLARVIS_ITERATION_CEILING: positiveInt.default(200),
  CLARVIS_TIMEOUT_CEILING_MS: positiveInt.max(2_147_483_647).default(600000),
  CLARVIS_ESCALATION_CEILING: positiveInt.default(20),
  CLARVIS_RETRY_CEILING: nonnegativeInt.default(10),
  CLARVIS_RETRY_AFTER_CEILING_MS: positiveInt.default(300000),

  CLARVIS_DEFAULT_TIMEOUT_MS: positiveInt.default(300000),
  CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT: positiveInt.default(160_000_000),
  CLARVIS_DEFAULT_ON_EXCEED: z.enum(["stop", "escalate"]).default("escalate"),
  CLARVIS_DEFAULT_MAX_ESCALATIONS: positiveInt.default(5),
  CLARVIS_DEFAULT_ELICIT_WAIT_MS: positiveInt.default(1_800_000),
  CLARVIS_DEFAULT_ITERATION_LIMIT: positiveInt.default(200),
  CLARVIS_DEFAULT_CONTEXT_WINDOW_TOKENS: positiveInt.default(128000),
  CLARVIS_DEFAULT_STAGNATION_THRESHOLD: nonnegativeInt.default(3),
  /**
   * The repeat count at which the stagnation guard warns the model, one below
   * its hard threshold by default so there is a full iteration of notice; `0`
   * disables the warning tier.
   */
  CLARVIS_DEFAULT_STAGNATION_SOFT_THRESHOLD: nonnegativeInt.default(2),
  /**
   * How many hard convergence-guard trips one run may be waved through by a
   * human; `0` disables escalation entirely, restoring the terminate-on-trip
   * behaviour even for a run that asked for escalation.
   *
   * @remarks Deliberately separate from `CLARVIS_DEFAULT_MAX_ESCALATIONS`: the
   * two bound different things, and sharing a counter would let a chatty budget
   * spend the guard's allowance before the guard ever fired.
   *
   * Lower than that one for the same reason they are separate. A budget
   * escalation is evidence the *estimate* was wrong, which is ordinary and worth
   * indulging several times; a guard escalation is evidence the *run* is wrong —
   * it has already repeated a failing call or stopped making progress — and
   * resuming it asks the human to bet against the only evidence available. Two
   * covers the case where the human knows something the guard cannot see, twice,
   * without letting a stuck run be waved along indefinitely.
   */
  CLARVIS_GUARD_MAX_ESCALATIONS: nonnegativeInt.default(2),
  CLARVIS_DEFAULT_CALL_TIMEOUT_MS: positiveInt.default(180000),
  CLARVIS_DEFAULT_REASONING_SUMMARY: reasoningSummary.default("off"),
  CLARVIS_DEFAULT_REASONING_EFFORT: reasoningEffort.optional(),
  CLARVIS_DEFAULT_MAX_RETRIES: nonnegativeInt.default(3),
  CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS: positiveInt.default(60000),
  CLARVIS_DEFAULT_COMPACTION_ENABLED: boolFromEnv(true),
  CLARVIS_DEFAULT_COMPACTION_CONTEXT_FRACTION: z.coerce.number().gt(0).max(1).default(0.8),
  CLARVIS_DEFAULT_COMPACTION_TARGET_FRACTION: z.coerce.number().gt(0).max(1).default(0.5),
  CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS: positiveInt.optional(),
  CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS: nonnegativeInt.optional(),
  CLARVIS_DEFAULT_FORCE_TOOL_ON_NUDGE: boolFromEnv(true),
  CLARVIS_DEFAULT_PENDING_TASK_NUDGES: nonnegativeInt.default(DEFAULT_PENDING_TASK_NUDGES),
  CLARVIS_STREAM: boolFromEnv(true),

  CLARVIS_OWNER: z.string().min(1).optional(),
  CLARVIS_AGENT_TOOLS_ENABLED: boolFromEnv(true),
  CLARVIS_AGENT_TOOLS_CONFINE: boolFromEnv(true),
  CLARVIS_AGENT_TOOLS_MAX_GRANT: z.enum(["none", "read", "edit", "exec"]).default("edit"),
  CLARVIS_SKILLS_ENABLED: boolFromEnv(true),
  CLARVIS_HOOKS_ENABLED: boolFromEnv(true),
  /**
   * Per-run budget for the memory *read* tools; writes are never rate-limited.
   *
   * @remarks 4 was the number of read tools, so an agent could not call each
   * one once and then follow anything up — while the seed preamble and the
   * capability's system section both tell it to navigate the wiki. The real
   * cost is the text that comes back, and that is already capped per call, so
   * the ceiling can afford to be a ceiling rather than a leash.
   */
  CLARVIS_MEMORY_TOOL_CALL_LIMIT: positiveInt.default(12),
  /**
   * How long the memory tree lock may be held before the release path says so.
   *
   * @remarks An index pass must never be started from inside `store.exclusive`:
   * the file store's lock is re-entrant, so the mistake does not deadlock — it
   * silently holds the tree lock for a whole inference, blocking the memory
   * panel, the wiki tools and every concurrent run's seed. Nothing enforces
   * that rule statically, so the enforcement is a warning past this threshold.
   * Five seconds is far above any legitimate batch and far below one inference.
   */
  CLARVIS_MEMORY_LOCK_WARN_MS: positiveInt.default(5000),
  /**
   * Wall budget for capability activation and seed contributions.
   *
   * @remarks Bounds the concurrent `forRun` activations, which run before the
   * first model call — so the user is watching an empty screen for whatever this
   * allows. Bracketed on both sides: below it a capability doing ordinary local
   * I/O (scanning a plan directory, reading the memory tree) is skipped and the
   * run silently loses a feature; above it a misbehaving capability becomes a
   * startup hang with nothing on screen to explain it. 5000 is the same figure
   * `HOOK_DEFAULT_TIMEOUT_MS.tool` uses for the same class of work —
   * local I/O, never inference — and the two are meant to read as one budget.
   *
   * The `max` is the point of the ceiling: activation is a wall the user
   * experiences, so an operator may tighten it freely but cannot raise it into
   * an unbounded wait.
   */
  CLARVIS_CAPABILITY_SETUP_TIMEOUT_MS: positiveInt.max(60_000).default(5000),
  /**
   * Wall budget for `finalizeRun` and `onRunEnd`.
   *
   * @remarks Deliberately shorter than the setup budget, because it is spent
   * *after* the user has their answer: every millisecond here is pure latency on
   * a run that is already decided. The floor is one durable write — the intent a
   * capability must get to disk before the response returns — and the ceiling is
   * anything resembling an inference call, which the contract forbids awaiting
   * here at all. `HOOK_DEFAULT_TIMEOUT_MS.run_end` matches this value on
   * purpose; that constant's own remarks say why.
   */
  CLARVIS_CAPABILITY_RUN_END_TIMEOUT_MS: positiveInt.default(2000),
  /** Physical host quotas for extension code that outlives its logical timeout. */
  CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS: positiveInt.max(256).default(32),
  CLARVIS_MAX_CONCURRENT_EXTENSION_RUN_END_CALLS: positiveInt.max(64).default(8),
  CLARVIS_MAX_CONCURRENT_EXTENSION_CALLS_PER_OPERATION: positiveInt.max(16).default(4),
  /**
   * The global floor every Clarvis logger starts at.
   *
   * @remarks Derived from {@link LOG_LEVELS} rather than spelled again, because
   *   the two disagreed: this enum admitted `trace` and `fatal`, which the
   *   `Logger` port has no method for, so `CLARVIS_LOG_LEVEL=trace` selected
   *   pino behaviour no capability could produce.
   */
  CLARVIS_LOG_LEVEL: z.enum(LOG_LEVELS).default(DEFAULT_LOG_LEVEL),
  /**
   * Per-component overrides of {@link CLARVIS_LOG_LEVEL}, as a comma-separated
   * list of `component=level` — e.g. `paths.lease=debug,mcp=debug,llm=warn`.
   *
   * @remarks Typed as an opaque string, not a schema, because the component
   *   vocabulary is open the way `TraceKind` is: a capability living outside the
   *   engine names its own subsystem without the engine declaring it. Parsed by
   *   `parseLogScopes`; a component no logger uses is a silent no-op.
   */
  CLARVIS_LOG: z.string().optional(),
  /**
   * Whether audit records — authentication and command-guard decisions — are
   * emitted regardless of the active level.
   *
   * @remarks Its own knob because `CLARVIS_LOG_LEVEL=warn` is a legitimate
   *   production setting and would otherwise silence every authentication
   *   success and every guard verdict. Environment only: a run that could write
   *   this through settings could silence the record of what it did.
   */
  CLARVIS_LOG_AUDIT: boolFromEnv(true),
  CLARVIS_MAX_PARALLEL_SUBAGENTS: positiveInt.default(4),
  CLARVIS_MAX_CONCURRENT_MODEL_CALLS: positiveInt.max(64).default(4),
  CLARVIS_MAX_QUEUED_MODEL_CALLS: nonnegativeInt.max(1024).default(8),
  /** Grace for a whole run to unwind after timeout/cancellation before its
   * non-cooperative tail is detached from persistence and host lifecycle. */
  CLARVIS_RUN_ABORT_SETTLE_MS: nonnegativeInt.default(2000),
  /** Shorter quarantine threshold for one physical provider transport. */
  CLARVIS_MODEL_ABORT_SETTLE_MS: nonnegativeInt.default(250),
  CLARVIS_COMPACTION_LLM_TIMEOUT_MS: positiveInt.default(120000),
  CLARVIS_PROVIDER_RETRY_BASE_MS: positiveInt.default(1000),
  CLARVIS_PROVIDER_RETRY_MAX_MS: positiveInt.default(30000),
  CLARVIS_PROVIDER_MAX_RESPONSE_BYTES: positiveInt.max(256 * 1024 * 1024).default(32 * 1024 * 1024),
  CLARVIS_PROVIDER_MAX_SSE_EVENT_BYTES: positiveInt.max(64 * 1024 * 1024).default(4 * 1024 * 1024),
  /**
   * What becomes of a stdio MCP server's own stderr: `log` forwards it as whole
   * lines through the host's logger, `off` discards it, `inherit` lets it reach
   * the host process's stderr as it did before a sink existed.
   *
   * @remarks Its own knob because this is third-party output, not Clarvis's. The
   *   default is `log`: `inherit` corrupts any host whose terminal is a rendered
   *   surface, which is what every server did until the transport's `onStderr`
   *   hook acquired a caller.
   */
  CLARVIS_MCP_SERVER_STDERR: z.enum(["off", "log", "inherit"]).default("log"),
  /** Forwarded stderr ceiling per connection, after which one suppression line is emitted. */
  CLARVIS_MCP_SERVER_STDERR_MAX_BYTES: positiveInt.default(64 * 1024),
  CLARVIS_MCP_CONNECT_TIMEOUT_MS: positiveInt.default(10000),
  CLARVIS_MCP_TOOL_CALL_TIMEOUT_MS: positiveInt.default(600000),
  CLARVIS_MCP_POOL_IDLE_TTL_MS: positiveInt.default(60000),
  CLARVIS_MCP_STDIO_MAX_FRAME_BYTES: positiveInt.max(64 * 1024 * 1024).default(16 * 1024 * 1024),
  CLARVIS_MCP_HTTP_MAX_RESPONSE_BYTES: positiveInt.max(64 * 1024 * 1024).default(16 * 1024 * 1024),
  CLARVIS_MCP_HTTP_MAX_SSE_EVENT_BYTES: positiveInt.max(16 * 1024 * 1024).default(4 * 1024 * 1024),
  CLARVIS_MCP_MAX_SERVERS_PER_RUN: positiveInt.max(1000).default(16),
  CLARVIS_MCP_MAX_CONNECTIONS: positiveInt.max(1024).default(32),
  CLARVIS_MCP_MAX_PARALLEL_CONNECTS: positiveInt.max(64).default(4),
  CLARVIS_MCP_MAX_IDLE_CONNECTIONS: nonnegativeInt.max(1024).default(8),
  CLARVIS_MCP_TIMEOUT_STREAK_THRESHOLD: positiveInt.default(3),
  CLARVIS_MCP_HEALTH_PING_INTERVAL_MS: nonnegativeInt.default(30000),
  CLARVIS_MCP_RESOURCES: boolFromEnv(true),
  CLARVIS_MCP_POOL_SHARING: z.enum(["owner", "workspace"]).default("owner"),

  CLARVIS_TRACE_TTL_DAYS: nonnegativeInt.default(30),
  CLARVIS_TRACE_CLEANUP_INTERVAL_MS: positiveInt.default(3_600_000),
  CLARVIS_TRACE_CLEANUP_BATCH_SIZE: positiveInt.default(1_000),
});

const DEFAULT_NOT_OVER_CEILING: ReadonlyArray<
  [keyof z.infer<typeof baseEnvSchema>, keyof z.infer<typeof baseEnvSchema>]
> = [
  ["CLARVIS_DEFAULT_TIMEOUT_MS", "CLARVIS_TIMEOUT_CEILING_MS"],
  ["CLARVIS_DEFAULT_CALL_TIMEOUT_MS", "CLARVIS_TIMEOUT_CEILING_MS"],
  ["CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT", "CLARVIS_TOKEN_CEILING"],
  ["CLARVIS_DEFAULT_ITERATION_LIMIT", "CLARVIS_ITERATION_CEILING"],
  ["CLARVIS_DEFAULT_MAX_ESCALATIONS", "CLARVIS_ESCALATION_CEILING"],
  ["CLARVIS_DEFAULT_MAX_RETRIES", "CLARVIS_RETRY_CEILING"],
  ["CLARVIS_DEFAULT_MAX_RETRY_AFTER_MS", "CLARVIS_RETRY_AFTER_CEILING_MS"],
];

/**
 * The full environment-configuration schema: the base `CLARVIS_*` field schema
 * plus a cross-field refinement that rejects any per-run default that exceeds
 * its matching hard ceiling (see {@link DEFAULT_NOT_OVER_CEILING}).
 *
 * @remarks Each violation is reported as a `custom` issue anchored on the
 *   offending default's key, so {@link loadEnv} can name it in the thrown error.
 */
export const envSchema = baseEnvSchema.superRefine((cfg, ctx) => {
  for (const [def, ceiling] of DEFAULT_NOT_OVER_CEILING) {
    const d = cfg[def] as number;
    const c = cfg[ceiling] as number;
    if (d > c) {
      ctx.addIssue({
        code: "custom",
        path: [def],
        message: `${def} (${d}) must be <= ${ceiling} (${c})`,
      });
    }
  }
  if (cfg.CLARVIS_MCP_MAX_SERVERS_PER_RUN > cfg.CLARVIS_MCP_MAX_CONNECTIONS) {
    ctx.addIssue({
      code: "custom",
      path: ["CLARVIS_MCP_MAX_SERVERS_PER_RUN"],
      message:
        `CLARVIS_MCP_MAX_SERVERS_PER_RUN (${String(cfg.CLARVIS_MCP_MAX_SERVERS_PER_RUN)}) must be <= ` +
        `CLARVIS_MCP_MAX_CONNECTIONS (${String(cfg.CLARVIS_MCP_MAX_CONNECTIONS)})`,
    });
  }
});

/** The parsed, frozen environment configuration produced by {@link loadEnv}. */
export type EnvConfig = Readonly<z.infer<typeof baseEnvSchema>>;

/**
 * Parse and validate process environment into a frozen {@link EnvConfig},
 * applying defaults and coercions from {@link envSchema}.
 *
 * @param source - the environment to read (defaults to `process.env`).
 * @returns the validated, `Object.freeze`d configuration.
 * @throws {@link Error} with every schema issue joined into one message when the
 *   environment is invalid (a bad field or a default over its ceiling).
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): EnvConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  return Object.freeze(parsed.data);
}
