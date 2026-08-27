import { PLANS_DEFAULTS } from "@clarvis/plan/settings";
import {
  agentPromptOf,
  mcpServerSettingsSchema,
  normalizeTools,
  settingsServerToEngine,
} from "@clarvis/loop/host";
import { type AgentProfile, type McpServerConfig, type SkillsProvider } from "@clarvis/loop";
import { kernelError } from "../core/errors.ts";
import type { AgentRecord, ConfigStore, ContextRecord } from "../config/config-store.ts";
import { renderSkillPrompt, skillEntryAgent } from "../skills/render-skill-prompt.ts";
import { protoMessagesToEngine } from "./map-message.ts";
import { guardParksOnHuman } from "../guard/resolver.ts";
import type { RunRequestAssembler } from "./run-service.ts";
import type { PlansMode } from "@clarvis/protocol";

/** The subset of merged config settings this assembler reads when building a run
 * request; deliberately loose, since the config store owns the full schema. */
interface EngineSettings {
  default_model?: string;
  default_vision_model?: string;
  default_reasoning_effort?: string;
  providers?: unknown[];
  mcpServers?: Record<string, Record<string, unknown>>;
  budget?: unknown;
  plans?: unknown;
  agents?: unknown;
  /** Read only to decide whether the run parks on a human for guard confirmations. */
  guard?: Parameters<typeof guardParksOnHuman>[1];
}

/** Defaults applied when agent frontmatter or merged settings omit model/limits/entry agent. */
export interface SettingsAssemblerOptions {
  /** Model used when neither `default_model` nor agent frontmatter names one. */
  defaultModel?: string;
  /** Iteration cap applied when an agent's frontmatter omits `iteration_limit`
   * (falls back to 20 when this is also unset). */
  defaultIterationLimit?: number;
  /** Entry agent used when a start request names none. */
  defaultAgent?: string;
  /** Token limit for the fallback budget used when neither the entry agent nor
   * merged settings declares one (defaults to
   * {@link FALLBACK_TOTAL_TOKEN_LIMIT}). */
  fallbackTokenLimit?: number;
  /** `on_exceed` for that fallback budget (defaults to
   * {@link FALLBACK_ON_EXCEED}).
   *
   * @remarks `"stop"` is the setting a headless host wants: on `"escalate"` a
   * soft-limit breach asks a human, and with nobody to answer the run parks for
   * the elicit wait bound while its compute clock is paused. */
  fallbackOnExceed?: "stop" | "escalate";
  /** Skills source used to resolve a run started against a skill; without it a
   * `skill` start param cannot be honoured and is rejected. */
  skills?: SkillsProvider;
  /** Resolves a trusted Plans override for a skill and its scanned provenance. */
  skillPlansMode?: (skill: { name: string; source?: string }) => PlansMode | undefined;
}

/** A resolved skill run: the agent it enters on and the message that seeds it. */
interface SkillRun {
  /** The agent the skill names for itself, or `undefined` to keep the caller's. */
  agent?: string;
  /** The rendered skill prompt, appended as the run's final user message. */
  seed: string;
  /** Root provenance used to bind packaged run policy to the skill that won. */
  source?: string;
}

/**
 * Resolve a `skill` start param into the agent a skill run enters on and the
 * message that seeds it.
 *
 * @param skill - the requested skill and its optional task; `undefined` for an
 *   ordinary run.
 * @param skills - the skills source, when the host configured one.
 * @returns the resolved {@link SkillRun}, or `undefined` when no skill was requested.
 * @throws {@link kernelError | KernelException} `not_found` when no skills source
 *   is configured, the skill does not exist, or it is not user-invocable —
 *   matching how {@link createSkillsService}'s `getPrompt` rejects the same cases.
 *
 * @remarks
 * A skill that names an agent through its frontmatter `agent` field overrides
 * the request's `agent`: the run is the skill's, not the caller's current
 * profile. A skill naming none reaches this path too — a host that renders it
 * into the current turn still forwards `skill` on the start request, so the seed
 * is re-rendered here and the local copy of the skill message is left out of
 * `messages` — and simply leaves the request's `agent` untouched.
 */
function resolveSkillRun(
  skill: { name: string; task?: string } | undefined,
  skills: SkillsProvider | undefined,
): SkillRun | undefined {
  if (skill === undefined) return undefined;
  const content = skills?.loadSkill(skill.name);
  if (content === undefined || !content.userInvocable) {
    throw kernelError("not_found", `skill '${skill.name}' is not available`);
  }
  const agent = skillEntryAgent(content.metadata);
  return {
    ...(agent !== undefined ? { agent } : {}),
    seed: renderSkillPrompt(skill.name, content.description, content.body, skill.task),
    ...(typeof content.source === "string" && content.source.length > 0
      ? { source: content.source }
      : {}),
  };
}

/**
 * Spell a user-invoked skill the way external prompt-expansion hooks identify it.
 *
 * @remarks Plugin provenance is preserved as `<plugin>:<skill>` so a hook can
 * distinguish its own command from a same-named skill in another source. User
 * and built-in skills remain bare because they have no plugin namespace.
 */
function hookCommandName(skill: { name: string }, source: string | undefined): string {
  const plugin = source?.startsWith("plugin:") ? source.slice("plugin:".length) : undefined;
  return plugin === undefined || plugin.length === 0 ? skill.name : `${plugin}:${skill.name}`;
}

/** Token limit of the fallback budget when the host configures none. */
const FALLBACK_TOTAL_TOKEN_LIMIT = 160_000_000;

/** `on_exceed` of the fallback budget when the host configures none. */
const FALLBACK_ON_EXCEED = "escalate";

/**
 * Project the `plans:` settings block onto the run request's `plans` param,
 * preserving `mode`, `retention` and `pending_task_nudges`.
 *
 * @remarks
 * `retention` is always **materialized** — an absent or malformed value becomes
 * {@link PLANS_DEFAULTS}`.retention` rather than being dropped. Omitting it would
 * push the decision down to the plan store's own fallback and leave the settings
 * default unreachable, so every run request carries an explicit retention.
 * An unrecognized `mode` falls back to the default rather than disabling
 * planning silently; `mode: "off"` is honoured as the user's explicit opt-out.
 */
function plansBlockToParam(block: Record<string, unknown>): {
  mode: "off" | "on" | "review";
  retention: "discard" | "keep";
  pending_task_nudges?: number;
} {
  const mode = block.mode;
  const retention = block.retention;
  const nudges = block.pending_task_nudges;
  return {
    mode: mode === "off" || mode === "on" || mode === "review" ? mode : PLANS_DEFAULTS.mode,
    retention:
      retention === "discard" || retention === "keep" ? retention : PLANS_DEFAULTS.retention,
    ...(typeof nudges === "number" && Number.isInteger(nudges) && nudges >= 0
      ? { pending_task_nudges: nudges }
      : {}),
  };
}

/** The numeric fields of the `agents:` block, all optional and all ceilings. */
const AGENTS_FIELDS = [
  "buffer_lines",
  "buffer_bytes",
  "max_total_buffer_bytes",
  "poll_max_bytes",
  "await_timeout_ms",
  "max_live_children",
  "max_retained_children",
  "max_notices_per_iteration",
  "max_consecutive_failed_children",
  "finish_nudges",
] as const;

/**
 * Project the `agents:` settings block onto the run request's `agents` param.
 *
 * @param block - the merged `agents` block from settings.json.
 * @returns the param, carrying only the fields the operator actually set.
 * @remarks Deliberately unlike {@link plansBlockToParam}, which *materializes* a
 * default for every field: there the settings default would otherwise be
 * unreachable behind the plan store's own fallback. Here the loop owns the
 * defaults outright (`AGENTS_DEFAULTS`), so an absent field must stay absent —
 * writing one out would freeze today's default into every run request and make a
 * later change to it invisible. A non-integer or non-positive value is dropped
 * rather than clamped: it is an operator typo, and the product default is a
 * better answer than a guess at what they meant.
 */
function agentsBlockToParam(block: Record<string, unknown>): Record<string, number> {
  const param: Record<string, number> = {};
  for (const key of AGENTS_FIELDS) {
    const value = block[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) param[key] = value;
  }
  return param;
}

/**
 * Validates one merged `mcpServers` entry and translates it into the engine's
 * server config.
 *
 * @param name - the server's key in the merged `mcpServers` map.
 * @param entry - the raw entry, typed loosely because {@link EngineSettings}
 *   leaves the full schema to the config store.
 * @returns the engine-shaped server config.
 * @throws {@link kernelError | KernelException} `invalid_request` naming the
 *   server when the entry does not satisfy `mcpServerSettingsSchema`.
 * @remarks The parse is not ceremony: `settings.json` spells the transport `type`
 *   while the engine's strict request schema spells it `transport`, so an entry
 *   forwarded verbatim is rejected downstream as an unrecognized key and takes
 *   the whole run with it. Failing here — loudly, naming the server — is also why
 *   a bad entry is never dropped silently: a dropped server surfaces much later
 *   as `profile '...' lists tool '...', which is not in the tool pool`, which
 *   points at the agent rather than at the typo.
 */
function toEngineServer(name: string, entry: Record<string, unknown>): McpServerConfig {
  const parsed = mcpServerSettingsSchema.safeParse(entry);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw kernelError("invalid_request", `mcpServers['${name}'] is not a valid server: ${detail}`);
  }
  return settingsServerToEngine(name, parsed.data);
}

/**
 * Builds one engine {@link AgentProfile} from an agent's markdown record.
 *
 * @param record - the agent's parsed frontmatter and body.
 * @param merged - merged config settings (supplies `default_model` and
 *   `default_reasoning_effort`).
 * @param options - assembler defaults for model and iteration limit.
 * @param entry - whether this is the run's lead profile rather than a spawnable child.
 * @returns the profile, carrying optional frontmatter fields (grants,
 *   `can_spawn`, orchestration, base prompt, reasoning, retry, compaction,
 *   stagnation threshold, call timeout, ...) only when present and valid.
 * @throws a `invalid_request` kernel error when no model can be resolved from
 *   frontmatter, `merged.default_model`, or `options.defaultModel`.
 * @remarks The user's `/model` and `/effort` defaults are authoritative for the
 *   entry profile. A spawned child instead keeps an explicit model or effort from
 *   its own profile, falling back to those defaults only when it declares none.
 *   This distinction lets changing the current run model do what the user asked
 *   without flattening a heterogeneous sub-agent fleet. When no reasoning effort
 *   resolves, the loop's `CLARVIS_DEFAULT_REASONING_EFFORT` fallback remains last.
 *   Every other optional field is a straight frontmatter passthrough.
 */
function buildProfile(
  record: AgentRecord,
  merged: EngineSettings,
  options: SettingsAssemblerOptions,
  entry: boolean,
  contexts: readonly ContextRecord[] = [],
): AgentProfile {
  const fm = record.frontmatter;
  const agentModel = typeof fm.model === "string" ? fm.model : undefined;
  const model = entry
    ? (merged.default_model ?? agentModel ?? options.defaultModel)
    : (agentModel ?? merged.default_model ?? options.defaultModel);
  if (model === undefined) {
    throw kernelError(
      "invalid_request",
      `agent '${record.name}' declares no model and no default_model is set`,
    );
  }
  const agentPrompt = agentPromptOf(
    typeof fm.base_prompt === "string" ? fm.base_prompt : undefined,
    record.body,
  );
  const promptParts = [
    agentPrompt,
    ...contexts.map((context) => {
      const filename = context.path?.replaceAll("\\", "/").split("/").at(-1);
      const source = filename === undefined ? context.scope : `${context.scope}/${filename}`;
      return `## Context: ${source}\n\n${context.content}`;
    }),
  ].filter((part): part is string => part !== undefined && part.length > 0);
  const basePrompt = promptParts.length === 0 ? undefined : promptParts.join("\n\n");
  const tools = normalizeTools(fm.tools as string[] | string | undefined);
  const iterationLimit =
    typeof fm.iteration_limit === "number"
      ? fm.iteration_limit
      : (options.defaultIterationLimit ?? 20);
  const agentReasoningEffort =
    typeof fm.reasoning_effort === "string" ? fm.reasoning_effort : undefined;
  const reasoningEffort = entry
    ? (merged.default_reasoning_effort ?? agentReasoningEffort)
    : (agentReasoningEffort ?? merged.default_reasoning_effort);
  return {
    name: record.name,
    model,
    tools,
    iteration_limit: iterationLimit,
    ...(Array.isArray(fm.grants) ? { grants: fm.grants as AgentProfile["grants"] } : {}),
    ...(Array.isArray(fm.can_spawn) ? { can_spawn: (fm.can_spawn as unknown[]).map(String) } : {}),
    ...(typeof fm.default_spawn === "string" ? { default_spawn: fm.default_spawn } : {}),
    ...(fm.orchestration && typeof fm.orchestration === "object"
      ? { orchestration: fm.orchestration }
      : {}),
    ...(basePrompt !== undefined ? { base_prompt: basePrompt } : {}),
    ...(typeof fm.description === "string" ? { description: fm.description } : {}),
    ...(reasoningEffort !== undefined
      ? { reasoning_effort: reasoningEffort as AgentProfile["reasoning_effort"] }
      : {}),
    ...(typeof fm.reasoning_summary === "string"
      ? { reasoning_summary: fm.reasoning_summary as AgentProfile["reasoning_summary"] }
      : {}),
    ...(fm.retry && typeof fm.retry === "object" ? { retry: fm.retry } : {}),
    ...(fm.compaction && typeof fm.compaction === "object" ? { compaction: fm.compaction } : {}),
    ...(typeof fm.stagnation_threshold === "number"
      ? { stagnation_threshold: fm.stagnation_threshold }
      : {}),
    ...(typeof fm.call_timeout_ms === "number" ? { call_timeout_ms: fm.call_timeout_ms } : {}),
  };
}

/**
 * Builds a {@link RunRequestAssembler} from config store settings and agent markdown profiles.
 * Expands `can_spawn` into a profile graph and selects MCP servers referenced by tool namespaces.
 *
 * @param store - the config store the assembler reads merged settings and agent
 *   records from on each call. Every profile in the graph comes from
 *   `readEffectiveAgent`, so a workspace file shadows a global one, and either
 *   overlays the agent Clarvis ships under that name — the entry and its
 *   transitive `can_spawn` children resolve by exactly the same rule.
 * @param options - defaults for model, iteration limit, and entry agent.
 * @returns an assembler that, per run, resolves the entry agent, transitively
 *   expands `can_spawn` into a deduplicated profile graph, appends each scope's
 *   effective context preamble to the entry profile, attaches only the MCP servers
 *   named by some profile's tool namespaces, and picks the budget
 *   (entry agent > merged settings > the fallback built from
 *   {@link SettingsAssemblerOptions.fallbackTokenLimit} and
 *   {@link SettingsAssemblerOptions.fallbackOnExceed}). The `plans` param
 *   is taken from the request when given, else projected from the merged
 *   `plans:` block via {@link plansBlockToParam}; other optional params pass
 *   through only when present.
 * @throws a `invalid_request` kernel error when no entry agent is given or
 *   configured, a `not_found` kernel error when the entry agent is undefined or
 *   a requested skill is unavailable, or the error {@link buildProfile} raises
 *   when an agent resolves no model.
 * @remarks A `can_spawn` child that names no defined agent is skipped rather than
 *   failing the run.
 *
 * A request carrying `skill` is assembled as a **skill run**: the skill is
 * resolved through {@link resolveSkillRun}, its rendered prompt is appended as
 * the run's final user message, and an agent the skill names for itself becomes
 * the entry — so the profile graph, tools and budget are that agent's. The
 * `skill` key itself is deliberately not forwarded to the engine, which has no
 * concept of one; everything a skill run means is expressed as an ordinary
 * request.
 */
export function createSettingsRunAssembler(
  store: ConfigStore,
  options: SettingsAssemblerOptions = {},
): RunRequestAssembler {
  const fallbackBudget = {
    on_exceed: options.fallbackOnExceed ?? FALLBACK_ON_EXCEED,
    total_token_limit: options.fallbackTokenLimit ?? FALLBACK_TOTAL_TOKEN_LIMIT,
  };
  /**
   * Complete a settings- or agent-declared budget into the shape a run request
   * requires.
   *
   * @remarks `on_exceed` is optional in settings and in agent frontmatter — a
   * default is allowed to say only how much to spend, without also restating
   * what happens at the wall — but it is *required* on a request, which is a
   * complete instruction. Filling it here is what lets
   * `budget: { total_token_limit: 200000 }` be a legal thing to write in
   * `settings.json` without the run that inherits it failing validation.
   */
  const completeBudget = (
    declared: Record<string, unknown> | undefined,
    fallback: { on_exceed: string; total_token_limit: number },
  ): Record<string, unknown> => {
    if (declared === undefined) return fallback;
    return declared.on_exceed === undefined
      ? { ...declared, on_exceed: fallback.on_exceed }
      : declared;
  };
  return (params) => {
    const merged = store.readSettings().merged as unknown as EngineSettings;
    const contexts = (["global", "workspace"] as const).flatMap((scope) => {
      const context = store.readContext(scope);
      return context === null ? [] : [context];
    });

    const skillRun = resolveSkillRun(params.skill, options.skills);
    const skillPlansMode =
      params.skill === undefined || skillRun === undefined
        ? undefined
        : options.skillPlansMode?.({
            name: params.skill.name,
            ...(skillRun.source !== undefined ? { source: skillRun.source } : {}),
          });

    const agentName = skillRun?.agent ?? params.agent ?? options.defaultAgent;
    if (agentName === undefined) {
      throw kernelError("invalid_request", "no agent given and no default agent is configured");
    }
    const entryRecord = store.readEffectiveAgent(agentName);
    if (entryRecord === null) {
      throw kernelError("not_found", `agent '${agentName}' is not defined`);
    }

    const profiles: AgentProfile[] = [];
    const seen = new Set<string>();
    const queue: string[] = [agentName];
    while (queue.length > 0) {
      const name = queue.shift()!;
      if (seen.has(name)) continue;
      seen.add(name);
      const rec = name === agentName ? entryRecord : store.readEffectiveAgent(name);
      if (rec === null) continue;
      const entry = name === agentName;
      const profile = buildProfile(rec, merged, options, entry, entry ? contexts : []);
      profiles.push(profile);
      for (const child of profile.can_spawn ?? []) queue.push(child);
    }

    const registry = merged.mcpServers ?? {};
    const allServerRefs = new Set(
      profiles
        .flatMap((p) => p.tools)
        .map((t) => t.split(".")[0] ?? "")
        .filter(Boolean),
    );
    const servers = [...allServerRefs].flatMap((name) => {
      const entry = registry[name];
      return entry === undefined ? [] : [toEngineServer(name, entry)];
    });

    const entryBudget = entryRecord.frontmatter.budget;
    const agentBudget =
      typeof entryBudget === "object" && entryBudget !== null ? entryBudget : undefined;

    return {
      messages: [
        ...protoMessagesToEngine(params.messages),
        ...(skillRun !== undefined ? [{ role: "user" as const, content: skillRun.seed }] : []),
      ],
      providers: merged.providers ?? [],
      servers,
      profiles,
      entry: agentName,
      budget: completeBudget(
        (agentBudget ?? merged.budget) as Record<string, unknown> | undefined,
        fallbackBudget,
      ),
      ...(typeof merged.default_vision_model === "string"
        ? { vision_model: merged.default_vision_model }
        : {}),
      ...(params.execution_id !== undefined ? { execution_id: params.execution_id } : {}),
      ...(params.continue_from !== undefined ? { continue_from: params.continue_from } : {}),
      ...(params.prompt_cache_key !== undefined
        ? { prompt_cache_key: params.prompt_cache_key }
        : {}),
      ...(params.prompt_cache_ttl !== undefined
        ? { prompt_cache_ttl: params.prompt_cache_ttl }
        : guardParksOnHuman(params.guard_mode, merged.guard, params.guard_judge !== undefined)
          ? { prompt_cache_ttl: "1h" as const }
          : {}),
      ...(params.output_schema !== undefined ? { output_schema: params.output_schema } : {}),
      ...(params.guard_mode !== undefined ? { guard_mode: params.guard_mode } : {}),
      ...(params.guard_judge !== undefined ? { guard_judge: params.guard_judge } : {}),
      ...(params.skill !== undefined && skillRun !== undefined
        ? {
            hook_user_prompt_expansion: {
              command_name: hookCommandName(params.skill, skillRun.source),
            },
          }
        : {}),
      ...(params.memory !== undefined ? { memory: params.memory } : {}),
      ...(params.task !== undefined ? { task: params.task } : {}),
      ...(params.plans !== undefined
        ? { plans: params.plans }
        : skillPlansMode !== undefined
          ? {
              plans: {
                ...plansBlockToParam(
                  typeof merged.plans === "object" && merged.plans !== null
                    ? (merged.plans as Record<string, unknown>)
                    : {},
                ),
                mode: skillPlansMode,
              },
            }
          : typeof merged.plans === "object" && merged.plans !== null
            ? { plans: plansBlockToParam(merged.plans as Record<string, unknown>) }
            : {}),
      ...(typeof merged.agents === "object" && merged.agents !== null
        ? { agents: agentsBlockToParam(merged.agents as Record<string, unknown>) }
        : {}),
    };
  };
}
