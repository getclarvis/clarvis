/**
 * The settings.json / run-request / plugin-manifest contract for the guard of
 * the built-in coding toolset. Owned by the loop (pure zod, no
 * @clarvis/tools import) so the settings schema — reachable from the main
 * entrypoint via settings-schema → settings-specs — carries no static
 * dependency on the optional tools package. The runtime capability
 * (tools.ts) re-exports these for API stability.
 */
import { z } from "zod";
import type { GuardMode } from "@clarvis/capability";
import type { CapabilitySettingsSpec } from "@clarvis/capability";
import { INPUT_LIMITS } from "../../validation/input-limits.ts";

const boundedPatternList = z
  .array(z.string().min(1).max(INPUT_LIMITS.commandPatternChars))
  .max(INPUT_LIMITS.commandPatterns);
const boundedSandboxList = z
  .array(z.string().min(1).max(INPUT_LIMITS.pathChars))
  .max(INPUT_LIMITS.sandboxListEntries);

const guardSchema = z
  .object({
    type: z
      .enum(["shell"], {
        error: "guard.type must be 'shell'",
      })
      .describe(
        "Type of guard to activate. Names the policy, not a shell syntax: the dialect is derived from the host platform.",
      ),
    mode: z
      .enum(["off", "on", "auto"], {
        error: "guard.mode must be 'off', 'on' or 'auto'",
      })
      .optional()
      .describe(
        "Default guard mode for runs that do not pass guard_mode: 'off' disables the " +
          "guard, 'on' relays 'ask' verdicts as confirmation prompts, 'auto' has an " +
          "LLM answer each ask — deny verdicts are always enforced first, and the " +
          "client must supply the judge prompt per run (without one, runs behave as " +
          "'on'). Default when absent: 'on'. Disabling the guard is an explicit, " +
          "persisted choice: write 'off' rather than deleting this block.",
      ),
    allowed_commands: boundedPatternList
      .optional()
      .describe(
        "Optional allowlist of command patterns. An entry without `*` is a space-boundary " +
          "prefix over the normalized argv; an entry with `*` is an anchored full-match " +
          "glob. When set, a shell segment matching an entry is allowed; any other " +
          "segment prompts for confirmation (ask).",
      ),
    denied_commands: boundedPatternList
      .optional()
      .describe(
        "Optional denylist of command patterns, matched like allowed_commands entries " +
          "(space-boundary prefix over the normalized argv, or an anchored glob when " +
          "the entry contains `*`). A segment matching an entry denies the whole " +
          "command; the denylist wins over allowed_commands.",
      ),
  })
  .strict()
  .describe(
    "A workspace guard: a built-in policy that can deny or ask for confirmation " +
      "before a tool call executes, using semantic analysis from tools.",
  );

/** The validated `guard` settings block (the inferred shape of `guardSchema`). */
export type GuardConfig = z.infer<typeof guardSchema>;

const sandboxSchema = z
  .object({
    type: z.literal("native"),
    enabled: z.boolean().optional(),
    availability: z.enum(["required", "optional"]).optional(),
    filesystem: z.enum(["workspace-write", "workspace-read-only"]).optional(),
    network: z.enum(["host", "none"]).optional(),
    pass_env: boundedSandboxList.optional(),
    toolchains: z
      .object({
        mode: z.enum(["auto", "manual"]).optional(),
        include: boundedSandboxList.optional(),
        exclude: boundedSandboxList.optional(),
        extra_paths: boundedSandboxList.optional(),
        excluded_paths: boundedSandboxList.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .describe("Optional native sandbox for shell and monitor_start on Linux and macOS.");

/** The validated `sandbox` settings block (the inferred shape of `sandboxSchema`). */
export type SandboxSettings = z.infer<typeof sandboxSchema>;
/** {@link SandboxSettings} plus the host-resolved concrete path lists (read-only
 * extra paths and discovered toolchain roots) that {@link resolveSandboxHostPolicy}
 * fills in for the runtime. */
export type ResolvedSandboxSettings = SandboxSettings & {
  resolved_read_only_paths?: string[];
  resolved_runtime_paths?: string[];
};

/**
 * The effective default guard mode from a settings `guard` block: its explicit
 * `mode`, else `"on"`.
 *
 * @remarks
 * An absent `guard` block means *unconfigured*, not *disabled* — a workspace
 * nobody has set up yet still gets the guard. Turning it off is a decision the
 * user makes and that persists as `mode: "off"`, mirroring the choice already
 * made elsewhere: an opt-out expressed by deleting a block is indistinguishable
 * from never having configured one, and would be silently re-armed.
 *
 * With no `allowed_commands` this yields `ask` for every command, which is
 * useless on its own — it trains the operator to approve by reflex. The seeded
 * default allowlist is the other half of this posture, not a convenience.
 */
export function defaultGuardMode(guard: GuardConfig | undefined): GuardMode {
  return guard?.mode ?? "on";
}

/** Schema for the per-run `guard_mode` param (`off` | `on` | `auto`). */
export const guardModeSchema = z.enum(["off", "on", "auto"], {
  error: "guard_mode must be one of 'off', 'on', 'auto'.",
});

/**
 * Schema for the per-run `guard_judge` config that drives `guard_mode: "auto"`:
 * the caller-supplied judge `prompt` (relayed verbatim), an optional `model`,
 * `on_unsure` escalation policy, and a `timeout_ms`.
 */
export const guardJudgeSchema = z
  .object({
    prompt: z
      .string()
      .min(1, "guard_judge.prompt must be a non-empty string")
      .max(32_768, "guard_judge.prompt must be at most 32768 characters"),
    model: z.string().min(1).optional(),
    on_unsure: z.enum(["ask", "deny"]).optional(),
    timeout_ms: z.number().int().positive().max(120_000).optional(),
  })
  .strict();

/** The `guard` block of settings.json, spread into settingsSchema. */
export const AGENT_TOOLS_SETTINGS_FIELDS = {
  guard: guardSchema
    .optional()
    .describe(
      "Workspace guard: a built-in policy that can deny or ask for confirmation " +
        "before a tool call executes.",
    ),
  sandbox: sandboxSchema.optional(),
};

/** Per-run guard params, spread into the run request (and the mcp slim tool). */
export const AGENT_TOOLS_REQUEST_PARAMS = {
  guard_mode: guardModeSchema
    .optional()
    .describe(
      "Per-run guard mode. 'off': no permission checks. 'on': the workspace guard runs and " +
        "'ask' verdicts are relayed to the user via MCP elicitation (fails closed if the " +
        "client cannot elicit). 'auto': an LLM answers each ask using the caller-supplied " +
        "guard_judge prompt — deny verdicts are still enforced first, and there is no blind " +
        "auto-approve. Default: settings guard.mode when set, else 'on'.",
    ),
  guard_judge: guardJudgeSchema
    .optional()
    .describe(
      "Judge configuration for guard_mode 'auto'. The caller supplies the judge's entire " +
        "system prompt; the server relays it verbatim and appends only a JSON facts message " +
        "(tool, command, normalized segments, paths, undecidable flag). 'on_unsure' " +
        "(default 'ask') escalates unsure verdicts to the user via elicitation when the " +
        "client supports it, else denies. Requires guard_mode 'auto'.",
    ),
};

const GUARD_PLUGIN_FORBIDDEN_REASON =
  "a plugin may not contribute 'guard': guard is a singleton and the last writer wins, " +
  "so a plugin could silently disarm the workspace's own guard. Declare it in " +
  "settings.json instead.";

/** The `guard` entry of a plugin manifest: forbidden, with an explanation. */
export const GUARD_PLUGIN_FIELDS = {
  guard: z
    .undefined({ error: GUARD_PLUGIN_FORBIDDEN_REASON })
    .optional()
    .describe("Forbidden. Declared only so that trying it explains why."),
  sandbox: z
    .undefined({ error: "a plugin may not contribute 'sandbox'; declare it in settings.json" })
    .optional(),
};

/**
 * Registration entry that merges the `sandbox` block across settings scopes:
 * scalar fields take the last defined value, while `pass_env` and the toolchain
 * path lists union (with `excluded_paths` subtracted from `extra_paths`). Not
 * plugin-contributable — a plugin may not weaken the workspace sandbox.
 */
export const sandboxSettingsSpec: CapabilitySettingsSpec = {
  key: "sandbox",
  schema: sandboxSchema,
  merge: (scopes) => {
    const values = scopes.map((scope) => scope.value as SandboxSettings);
    const distinct = (lists: (string[] | undefined)[]): string[] | undefined => {
      const out = [...new Set(lists.flatMap((list) => list ?? []))];
      if (out.length > INPUT_LIMITS.sandboxListEntries) {
        throw new Error(
          `merged sandbox list exceeds ${String(INPUT_LIMITS.sandboxListEntries)} entries`,
        );
      }
      return out.length > 0 ? out : undefined;
    };
    const last = <K extends keyof SandboxSettings>(key: K): SandboxSettings[K] | undefined => {
      let value: SandboxSettings[K] | undefined;
      for (const item of values) if (item[key] !== undefined) value = item[key];
      return value;
    };
    const toolchains = values
      .map((value) => value.toolchains)
      .filter((value) => value !== undefined);
    const lastToolchain = <K extends keyof NonNullable<SandboxSettings["toolchains"]>>(
      key: K,
    ): NonNullable<SandboxSettings["toolchains"]>[K] | undefined => {
      let value: NonNullable<SandboxSettings["toolchains"]>[K] | undefined;
      for (const item of toolchains) if (item[key] !== undefined) value = item[key];
      return value;
    };
    const excludedPaths = distinct(toolchains.map((item) => item.excluded_paths));
    const excluded = new Set(excludedPaths ?? []);
    const extraPaths = distinct(toolchains.map((item) => item.extra_paths))?.filter(
      (path) => !excluded.has(path),
    );
    const mergedToolchains = {
      ...(lastToolchain("mode") !== undefined ? { mode: lastToolchain("mode") } : {}),
      ...(lastToolchain("include") !== undefined ? { include: lastToolchain("include") } : {}),
      ...(distinct(toolchains.map((item) => item.exclude)) !== undefined
        ? { exclude: distinct(toolchains.map((item) => item.exclude)) }
        : {}),
      ...(extraPaths !== undefined && extraPaths.length > 0 ? { extra_paths: extraPaths } : {}),
      ...(excludedPaths !== undefined ? { excluded_paths: excludedPaths } : {}),
    };
    return {
      type: "native" as const,
      ...(last("enabled") !== undefined ? { enabled: last("enabled") } : {}),
      ...(last("availability") !== undefined ? { availability: last("availability") } : {}),
      ...(last("filesystem") !== undefined ? { filesystem: last("filesystem") } : {}),
      ...(last("network") !== undefined ? { network: last("network") } : {}),
      ...(distinct(values.map((value) => value.pass_env)) !== undefined
        ? { pass_env: distinct(values.map((value) => value.pass_env)) }
        : {}),
      ...(Object.keys(mergedToolchains).length > 0 ? { toolchains: mergedToolchains } : {}),
    };
  },
  pluginContributable: false,
  pluginForbiddenReason: "a plugin may not contribute 'sandbox'; declare it in settings.json",
};

/**
 * Registration entry for the `guard` block: last scope wins, passes the
 * `guard_mode`/`guard_judge` run params through, and is not
 * plugin-contributable — a plugin could otherwise silently disarm the
 * workspace's own guard.
 */
export const agentToolsSettingsSpec: CapabilitySettingsSpec = {
  key: "guard",
  schema: guardSchema,
  merge: "lastWins",
  pluginContributable: false,
  pluginForbiddenReason: GUARD_PLUGIN_FORBIDDEN_REASON,
  requestParams: AGENT_TOOLS_REQUEST_PARAMS,
};
