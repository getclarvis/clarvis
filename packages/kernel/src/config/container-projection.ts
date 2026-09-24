import { z } from "zod";
import { kernelError } from "../core/errors.ts";
import type { EnvConfig, ModelExecutionInfo } from "@clarvis/capability";
import {
  agentFrontmatterSchema,
  agentPromptOf,
  normalizeTools,
  providerConfigSchema,
  settingsSchema,
  renderSharedPromptDocument,
  parseSharedPromptDocument,
} from "@clarvis/loop/host";
import { memoryConfigSchema } from "@clarvis/memory/schemas";
import { PLANS_SETTINGS_FIELDS } from "@clarvis/plan/settings";
import { WORKFLOWS_SETTINGS_FIELDS } from "@clarvis/workflows";
import type { ConfigStore, AgentRecord, ContextRecord, SettingsSnapshot } from "./config-store.ts";
import { resolveAgentsByName } from "./agent-resolution.ts";
import { BUILTIN_AGENTS, DEFAULT_ENTRY_AGENT } from "./builtin-agents/index.ts";
import { builtinAgentRecord } from "./agent-overlay.ts";
import {
  canonicalContainerJson,
  digestContainerJson,
  freezeContainerData,
} from "./container-projection-json.ts";
import {
  projectContainerLoopPolicy,
  validContainerLoopPolicy,
  type ContainerLoopPolicy,
} from "./container-projection-env.ts";
import {
  containerWorkflowSchema,
  projectContainerWorkflows,
  type ContainerWorkflowInput,
} from "./container-projection-workflows.ts";

export {
  CONTAINER_CONFIGURATION_MAX_BYTES,
  canonicalContainerJson,
} from "./container-projection-json.ts";
export {
  CONTAINER_ENV_SCOPES,
  projectContainerLoopPolicy,
  containerLoopEnvironment,
  type ContainerLoopPolicy,
} from "./container-projection-env.ts";
export type { ContainerWorkflowInput } from "./container-projection-workflows.ts";

const nameSchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/)
  .refine((name) => !["__proto__", "prototype", "constructor"].includes(name));
const frontmatterSchema = agentFrontmatterSchema.extend({
  orchestration: agentFrontmatterSchema.shape.orchestration.unwrap().strict().optional(),
});
const profileSchema = z
  .object({
    name: nameSchema,
    frontmatter: frontmatterSchema,
    prompt: z.string(),
    origin: z.enum(["builtin", "global", "workspace"]),
  })
  .strict();
const defaultsSchema = settingsSchema
  .pick({
    default_model: true,
    default_vision_model: true,
    default_reasoning_effort: true,
    budget: true,
  })
  .extend({
    defaultAgent: nameSchema,
    budget: settingsSchema.shape.budget
      .unwrap()
      .extend({ on_exceed: z.enum(["stop", "escalate"]) }),
  })
  .strict();
const nativeModel = providerConfigSchema.shape.models.unwrap().valueType.shape;
const modelSchema = z
  .object({
    provider: providerConfigSchema.shape.name,
    model: z
      .string()
      .min(1)
      .regex(/^[a-zA-Z0-9_./:-]+$/),
    kind: providerConfigSchema.shape.kind,
    contextWindowTokens: nativeModel.context_window_tokens,
    maxOutputTokens: nativeModel.max_output_tokens,
    capabilities: nativeModel.capabilities,
    reasoningEfforts: nativeModel.reasoning_efforts,
    promptCache: nativeModel.prompt_cache,
  })
  .strict();
const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !/^[\\/]|^[A-Za-z]:/.test(path) &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      !path.split("/").some((part) => part === ".." || part === "." || part === ""),
    "Memory path must be confined and relative",
  );
const localMemory = memoryConfigSchema
  .extend({
    enabled: z.literal(true),
    budgets: memoryConfigSchema.shape.budgets.unwrap().strict().optional(),
    provider: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("wiki") }).strict(),
      z.object({ kind: z.literal("file"), paths: z.array(relativePath).min(1) }).strict(),
    ]),
  })
  .strict();
const plansSchema = PLANS_SETTINGS_FIELDS.plans
  .unwrap()
  .omit({ provider: true })
  .extend({
    provider: z
      .object({ kind: z.literal("markdown") })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (value) => value.mode !== "off" || value.provider === undefined,
    "Disabled Plans cannot carry a provider",
  );
const shape = z
  .object({
    schemaVersion: z.literal(2),
    defaults: defaultsSchema,
    profiles: z.array(profileSchema).max(1024),
    sharedPrompt: z
      .string()
      .refine(
        (text) =>
          text === "" ||
          (text === text.trim() &&
            parseSharedPromptDocument(renderSharedPromptDocument("replace", text)).ok),
      ),
    contexts: z
      .array(z.object({ scope: z.enum(["global", "workspace"]), content: z.string() }).strict())
      .max(2),
    memoryPolicy: z.string(),
    plans: plansSchema,
    memory: z.union([z.object({ enabled: z.literal(false) }).strict(), localMemory]),
    workflows: z
      .object({
        settings: WORKFLOWS_SETTINGS_FIELDS.workflows.unwrap(),
        definitions: z.array(containerWorkflowSchema).max(1024),
      })
      .strict(),
    modelCatalog: z.array(modelSchema).max(4096),
    loopPolicy: z.custom<ContainerLoopPolicy>(
      validContainerLoopPolicy,
      "Invalid Container loop policy",
    ),
    toolPolicy: z
      .object({
        enabled: z.boolean(),
        maxGrant: z.enum(["none", "read", "edit", "exec"]),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const list of [
      value.profiles.map((p) => p.name),
      value.contexts.map((c) => c.scope),
      value.modelCatalog.map((m) => `${m.provider}/${m.model}`),
      value.workflows.definitions.map((w) => w.name),
    ]) {
      if (new Set(list).size !== list.length)
        ctx.addIssue({ code: "custom", message: "Duplicate Container configuration identity" });
    }
  });

/** Closed, canonical version-2 configuration. No host SettingsSnapshot or provider transport survives. */
export type ContainerConfiguration = z.infer<typeof shape>;

/** Runtime schema refuses lossy JSON, normalization/coercion, omitted canonical defaults and excess bytes. */
export const containerConfigurationSchema = z
  .unknown()
  .transform((value, ctx): ContainerConfiguration => {
    try {
      const canonical = canonicalContainerJson(value);
      const parsed = shape.parse(value);
      if (canonical !== canonicalContainerJson(parsed))
        throw new Error("Noncanonical configuration");
      return freezeContainerData(parsed);
    } catch {
      ctx.addIssue({ code: "custom", message: "Invalid or oversized Container configuration" });
      return z.NEVER;
    }
  });

/** Validate unknown transport data before creating any process or reading any guest file. */
export function parseContainerConfiguration(value: unknown): ContainerConfiguration {
  return containerConfigurationSchema.parse(value);
}

/** Stable SHA-256 identity; field insertion order is irrelevant, array order remains significant. */
export function containerConfigurationDigest(value: ContainerConfiguration): `sha256:${string}` {
  return digestContainerJson(parseContainerConfiguration(value));
}

/** Host-resolved ports. Prompts are effective text, never filenames or environment templates to expand. */
export interface ContainerProjectionInputs {
  store: Pick<ConfigStore, "readSettings" | "listAgents">;
  env: EnvConfig;
  modelCatalog: readonly ModelExecutionInfo[];
  sharedPrompt: string;
  contexts: readonly Pick<ContextRecord, "scope" | "content">[];
  memoryPolicy: string;
  workflowDefinitions: readonly ContainerWorkflowInput[];
  defaultAgent?: string;
}

/** Snapshot native/operator inputs only. Active external Memory/Plans fail before process admission; inherited Tasks are inert. */
export function projectContainerConfiguration(
  input: ContainerProjectionInputs,
): ContainerConfiguration {
  const snapshot = input.store.readSettings();
  if (snapshot.operator_merged === undefined)
    throw new Error("Container projection requires trust-filtered operator_merged settings");
  const settings = snapshot.operator_merged;
  const defaults = defaultsSchema.parse({
    ...(settings.default_model === undefined ? {} : { default_model: settings.default_model }),
    ...(settings.default_vision_model === undefined
      ? {}
      : { default_vision_model: settings.default_vision_model }),
    ...(settings.default_reasoning_effort === undefined
      ? {}
      : { default_reasoning_effort: settings.default_reasoning_effort }),
    defaultAgent: input.defaultAgent ?? DEFAULT_ENTRY_AGENT,
    budget: {
      total_token_limit: input.env.CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT,
      ...settingsSchema.shape.budget.unwrap().parse(settings.budget ?? {}),
      on_exceed:
        settingsSchema.shape.budget.unwrap().parse(settings.budget ?? {}).on_exceed ??
        input.env.CLARVIS_DEFAULT_ON_EXCEED,
    },
  });
  const plans = PLANS_SETTINGS_FIELDS.plans.unwrap().parse(settings.plans ?? {});
  if (plans.mode !== "off" && plans.provider !== undefined && plans.provider.kind !== "markdown")
    throw new Error("External Plans provider is unsupported in Container");
  const memory =
    settings.memory === undefined
      ? undefined
      : memoryConfigSchema
          .extend({ budgets: memoryConfigSchema.shape.budgets.unwrap().strict().optional() })
          .parse(settings.memory);
  if (
    memory?.enabled &&
    memory.provider !== undefined &&
    memory.provider.kind !== "wiki" &&
    memory.provider.kind !== "file"
  )
    throw new Error("External Memory provider is unsupported in Container");
  const records = resolveAgentsByName([
    ...BUILTIN_AGENTS.map(builtinAgentRecord),
    ...input.store
      .listAgents()
      .filter((record) => record.scope === "global" || record.scope === "workspace"),
  ]);
  const profiles = records.map((record) => {
    if (record.malformed !== undefined) throw new Error("Invalid Container Agent Profile");
    const frontmatter = frontmatterSchema.parse(record.frontmatter);
    if (record.scope === "builtin" && frontmatter.grants !== undefined)
      frontmatter.grants = frontmatter.grants.filter((grant) => grant !== "use_skills");
    const prompt = agentPromptOf(frontmatter.base_prompt, record.body) ?? "";
    delete frontmatter.base_prompt;
    return { name: record.name, frontmatter, prompt, origin: record.scope };
  });
  const configuration = {
    schemaVersion: 2,
    defaults,
    profiles,
    sharedPrompt: input.sharedPrompt,
    contexts: input.contexts.map((context) => ({ scope: context.scope, content: context.content })),
    memoryPolicy: memory?.enabled ? input.memoryPolicy : "",
    plans: {
      mode: plans.mode,
      retention: plans.retention,
      pending_task_nudges: plans.pending_task_nudges,
      ...(plans.mode === "off" ? {} : { provider: { kind: "markdown" } }),
    },
    memory: memory?.enabled
      ? {
          enabled: true,
          ...(memory.model === undefined ? {} : { model: memory.model }),
          ...(memory.budgets === undefined ? {} : { budgets: memory.budgets }),
          provider: memory.provider ?? { kind: "wiki" },
        }
      : { enabled: false },
    workflows: {
      settings: WORKFLOWS_SETTINGS_FIELDS.workflows.unwrap().parse(settings.workflows ?? {}),
      definitions: projectContainerWorkflows(input.workflowDefinitions),
    },
    modelCatalog: input.modelCatalog.map((model) => ({
      provider: model.provider,
      model: model.model,
      kind: model.kind,
      contextWindowTokens: model.contextWindowTokens,
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
      ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
      ...(model.reasoningEfforts === undefined ? {} : { reasoningEfforts: model.reasoningEfforts }),
      ...(model.promptCache === undefined ? {} : { promptCache: model.promptCache }),
    })),
    loopPolicy: projectContainerLoopPolicy(input.env),
    toolPolicy: {
      enabled: input.env.CLARVIS_AGENT_TOOLS_ENABLED,
      maxGrant: input.env.CLARVIS_AGENT_TOOLS_MAX_GRANT,
    },
  };
  return parseContainerConfiguration(configuration);
}

/** Selection status is derived, not trusted wire authority. Incompatible siblings do not poison independent graphs. */
export interface ContainerProfileAdmission {
  name: string;
  selectable: boolean;
  reason?: string;
}
const nativeGrants = new Set([
  "ask_user",
  "read_workspace",
  "edit_workspace",
  "run_commands",
  "workflow",
]);

/** Validate the complete reachable spawn graph; visited sets admit native cycles and refuse missing targets. */
export function validateContainerProfileSelection(
  configuration: ContainerConfiguration,
  name: string,
): void {
  const byName = new Map(configuration.profiles.map((profile) => [profile.name, profile]));
  const visited = new Set<string>();
  const queue = [name];
  while (queue.length > 0) {
    const next = queue.pop()!;
    if (visited.has(next)) continue;
    visited.add(next);
    const profile = byName.get(next);
    if (profile === undefined)
      throw kernelError("unsupported", "Container profile graph contains an unavailable target");
    const fm = profile.frontmatter;
    if (normalizeTools(fm.tools).length > 0 || fm.grants?.some((grant) => !nativeGrants.has(grant)))
      throw kernelError(
        "unsupported",
        "Container profile requires unsupported grants or MCP tools",
      );
    if (fm.default_spawn !== undefined && !fm.can_spawn?.includes(fm.default_spawn))
      throw kernelError(
        "invalid_request",
        "Container default_spawn must name an admitted can_spawn target",
      );
    for (const target of fm.can_spawn ?? []) {
      if (!nameSchema.safeParse(target).success)
        throw kernelError("invalid_request", "Invalid Container spawn target name");
      queue.push(target);
    }
  }
}

/** Report each effective profile's selectability independently, without echoing authored data in diagnostics. */
export function containerProfileAdmissions(
  configuration: ContainerConfiguration,
): ContainerProfileAdmission[] {
  return configuration.profiles.map((profile) => {
    try {
      validateContainerProfileSelection(configuration, profile.name);
      return { name: profile.name, selectable: true };
    } catch {
      return {
        name: profile.name,
        selectable: false,
        reason: "Unsupported Container profile graph",
      };
    }
  });
}

/** Immutable in-memory ConfigStore. Every write fails before callbacks; no guest loader or filesystem is used. */
export function createContainerConfigStore(value: ContainerConfiguration): ConfigStore {
  const configuration = parseContainerConfiguration(value);
  const denied = (): never => {
    throw kernelError("unsupported", "Container configuration is read-only");
  };
  const settings: SettingsSnapshot = {
    merged: {
      ...configuration.defaults,
      plans: configuration.plans,
      memory: configuration.memory,
      workflows: configuration.workflows.settings,
    },
    operator_merged: {
      ...configuration.defaults,
      plans: configuration.plans,
      memory: configuration.memory,
      workflows: configuration.workflows.settings,
    },
    scopes: {},
    sources: [],
  };
  const admissions = new Map(
    containerProfileAdmissions(configuration).map((item) => [item.name, item.selectable]),
  );
  const records = configuration.profiles.map((profile): AgentRecord => {
    const compatible = admissions.get(profile.name);
    return {
      name: profile.name,
      scope: profile.origin,
      frontmatter: profile.frontmatter,
      body: profile.prompt,
      ...(profile.frontmatter.model === undefined ? {} : { model: profile.frontmatter.model }),
      ...(profile.frontmatter.description === undefined
        ? {}
        : { description: profile.frontmatter.description }),
      ...(compatible ? {} : { malformed: "Unsupported Container profile graph" }),
    };
  });
  const clone = <T>(data: T): T => structuredClone(data);
  return {
    readSettings: () => clone(settings),
    readSettingsDocument: () => null,
    listAgents: () => clone(records),
    readAgent: (scope, name) =>
      clone(records.find((record) => record.scope === scope && record.name === name) ?? null),
    readEffectiveAgent: (name) => clone(records.find((record) => record.name === name) ?? null),
    readContext: (scope) =>
      clone(configuration.contexts.find((context) => context.scope === scope) ?? null),
    readSharedPrompt: (scope) =>
      scope === "global"
        ? {
            path: "container:shared-agent.md",
            raw: renderSharedPromptDocument(
              configuration.sharedPrompt === "" ? "disabled" : "replace",
              configuration.sharedPrompt,
            ),
          }
        : null,
    writeSettings: denied,
    mutateSettings: denied,
    compareAndSwapSettingsDocument: denied,
    withOperatorWrite: denied,
    setWorkspaceTrust: denied,
    writeAgent: denied,
    deleteAgent: denied,
    writeSharedPrompt: denied,
    deleteSharedPrompt: denied,
  };
}
