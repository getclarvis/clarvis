import { randomUUID } from "node:crypto";
import { MAX_JSON_MESSAGE_BYTES } from "../core/json-message.ts";
import type { RuntimeToolPolicy } from "./tool-policy.ts";
import { runtimeLoopPolicy, type RuntimeLoopPolicy } from "./loop-policy.ts";
import { planRefFromCapabilityState } from "../runs/plan-ref.ts";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { NOOP_LOGGER, resolveProvider, type RunRequest } from "@clarvis/capability";
import type { ElicitParams, ElicitRawResult, ExecuteRunArgs, LLMCallParams } from "@clarvis/loop";
import { withGuardElicitWaitBound } from "@clarvis/loop/capabilities/tools";
import type { RuntimeHost, RuntimeHostInput } from "./lazy-runtime.ts";
import type { ResolvedContainerRuntimeSettings } from "./settings.ts";
import {
  createCapabilityBroker,
  createModelBroker,
  type ModelBroker,
} from "./authority-brokers.ts";
import { createIsolatedRunExecutor, type RuntimeAuthorityRouter } from "./isolated-run-executor.ts";
import { forwardGuestGuardAudit } from "./guard-audit-bridge.ts";
import { RUNTIME_PREVIEW_METHOD, RUNTIME_PREVIEW_REVISION } from "./preview-capability.ts";
import { createHostPlansGrant, RUNTIME_PLANS_METHOD } from "./plan-bridge.ts";
import {
  createHostSkillsGrant,
  createRuntimeSkillBootstraps,
  createRuntimeSkillCatalog,
  RUNTIME_SKILLS_METHOD,
  type RuntimeSkillBootstrapEntry,
  type RuntimeSkillCatalogEntry,
} from "./skills-bridge.ts";
import { createHostMemoryBridge, RUNTIME_MEMORY_METHOD } from "./memory-bridge.ts";
import type { MemoryRuntimeDescriptor } from "@clarvis/memory/capability";
import { launchIsolatedRuntime } from "./runtime-controller.ts";
import {
  agentsPluginsDir,
  agentsSkillsDirs,
  workspacePaths,
  type RootOptions,
} from "@clarvis/paths";
import { RuntimeLaunchError, type RuntimeBackend } from "./types.ts";
import { prepareRuntimeCapabilityRoot } from "./runtime-workspace-control.ts";
import {
  createGuardRuntimeResolver,
  resolveGuardMode,
  type GuardSettings,
} from "../guard/resolver.ts";
import { streamHostModelCall } from "./model-stream.ts";
import { assertInlineModelMedia } from "./model-media.ts";
import { createHostRemoteMcpBridge, RUNTIME_MCP_METHOD } from "./remote-mcp.ts";
import { createGuardSessionAllowlist } from "../guard/guard-elicit.ts";
import {
  createHostGuardApprovalGrant,
  RUNTIME_GUARD_APPROVAL_METHOD,
} from "./guard-approval-bridge.ts";
import { createHostTasksGrant, RUNTIME_TASKS_METHOD } from "./tasks-bridge.ts";
import {
  createHostHooksBridge,
  RUNTIME_HOOKS_METHOD,
  type RuntimeHooksDescriptor,
} from "./hooks-bridge.ts";
import { workflowContextOf, workflowOutputBudgetOf, type WorkflowCtx } from "@clarvis/workflows";
import { goalRuntimePortOf } from "@clarvis/goal";
import {
  createHostGoalBridge,
  RUNTIME_GOAL_METHOD,
  RUNTIME_GOAL_MAX_BYTES,
  type RuntimeGoalDescriptor,
} from "./goal-bridge.ts";
import {
  consumeGuestWorkflowEvent,
  createHostWorkflowBridge,
  RUNTIME_WORKFLOWS_METHOD,
  type RuntimeWorkflowDescriptor,
} from "./workflows-bridge.ts";
import { createHostVcsGrant, RUNTIME_HOST_VCS_METHOD } from "./host-vcs-bridge.ts";

type LocalRuntimeInput = RuntimeHostInput;
type ResolvedLocalRuntimeInput = Omit<LocalRuntimeInput, "settings"> & {
  readonly settings: ResolvedContainerRuntimeSettings;
};

/** Engine-neutral options used by local Docker and Podman compositions. */
export interface LocalContainerRuntimeOptions {
  readonly roots?: RootOptions;
}

/** Inspect one nested control path without following any workspace-relative symlink. */
export async function inspectReservedWorkspacePath(
  candidate: string,
  workspaceRoot: string,
): Promise<Stats | undefined> {
  const fromRoot = relative(workspaceRoot, candidate);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new RuntimeLaunchError(
      "unsupported_policy",
      `reserved workspace path '${candidate}' is outside the selected workspace`,
    );
  }
  const segments = fromRoot.split(sep);
  let current = workspaceRoot;
  let result: Stats | undefined;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try {
      result = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new RuntimeLaunchError(
        "unsupported_policy",
        `runtime could not inspect reserved workspace path '${candidate}'`,
        { cause: error },
      );
    }
    if (result.isSymbolicLink()) {
      throw new RuntimeLaunchError(
        "unsupported_policy",
        `reserved workspace path '${candidate}' must not traverse symbolic links`,
      );
    }
    const final = index === segments.length - 1;
    if ((!final && !result.isDirectory()) || (final && !result.isDirectory() && !result.isFile())) {
      throw new RuntimeLaunchError(
        "unsupported_policy",
        `reserved workspace path '${candidate}' must be a regular file or directory`,
      );
    }
  }
  return result;
}

async function readOnlyWorkspacePaths(
  input: ResolvedLocalRuntimeInput,
): Promise<readonly string[]> {
  const paths = workspacePaths(input.workspaceRoot);
  const clarvisRoot = await inspectReservedWorkspacePath(paths.clarvisDir, paths.root);
  if (clarvisRoot !== undefined && !clarvisRoot.isDirectory()) {
    throw new RuntimeLaunchError(
      "unsupported_policy",
      `reserved workspace path '${paths.clarvisDir}' must be a directory`,
    );
  }
  for (const capabilityRoot of [
    ...(input.planFactory === undefined ? [] : [paths.plansRoot]),
    ...(input.memoryFactory === undefined ? [] : [paths.memoryRoot]),
  ]) {
    try {
      prepareRuntimeCapabilityRoot(capabilityRoot, paths.root);
    } catch (cause) {
      throw new RuntimeLaunchError(
        "unsupported_policy",
        `runtime could not prepare host-controlled workspace path '${capabilityRoot}'`,
        { cause },
      );
    }
  }
  const sharedSkills = agentsSkillsDirs({ cwd: paths.root, env: {} }).workspace;
  const candidates = [
    paths.settingsFile,
    paths.agentsDir,
    paths.skillsDir,
    paths.workflowsDir,
    paths.pluginsDir,
    paths.extensionProfilesDir,
    paths.guardJudgeFile,
    paths.memoryPolicyFile,
    paths.plansRoot,
    paths.memoryRoot,
    paths.plansRootForOwner(input.ownerId),
    paths.memoryRootForOwner(input.ownerId),
    sharedSkills,
    agentsPluginsDir(paths.root),
  ];
  const existing: string[] = [];
  for (const candidate of candidates) {
    const info = await inspectReservedWorkspacePath(candidate, paths.root);
    if (info === undefined) continue;
    existing.push(candidate);
  }
  return [...new Set(existing)];
}

/** Exact models the assembled request can use, including its resolved auxiliary paths. */
export function runtimeModelPairs(rawBody: unknown, guardSettings: GuardSettings): Set<string> {
  const raw = rawBody as {
    profiles?: Array<{ model?: unknown }>;
    vision_model?: unknown;
    guard_mode?: Parameters<typeof resolveGuardMode>[0];
    guard_judge?: { model?: string };
  };
  const pairs = new Set<string>();
  const models = [
    ...(raw.profiles ?? []).map((profile) => profile.model),
    raw.vision_model,
    ...(resolveGuardMode(raw.guard_mode, guardSettings.guard) === "auto" &&
    raw.guard_judge !== undefined
      ? [raw.guard_judge.model ?? guardSettings.defaultModel]
      : []),
  ];
  for (const model of models) {
    if (typeof model !== "string") continue;
    const slash = model.indexOf("/");
    if (slash > 0 && slash < model.length - 1) {
      pairs.add(`${model.slice(0, slash)}\0${model.slice(slash + 1)}`);
    }
  }
  return pairs;
}

function providerConfig(rawBody: unknown, provider: string): unknown {
  const raw = rawBody as { providers?: Array<{ name?: unknown }> };
  return raw.providers?.find((candidate) => candidate.name === provider);
}

/** Resolve a model lease to the exact destination admitted by its provider snapshot. */
export function modelDestination(rawBody: unknown, provider: string): URL {
  const config = providerConfig(rawBody, provider) as
    { kind?: unknown; base_url?: unknown } | undefined;
  if (config?.kind === "openai-compatible" && typeof config.base_url === "string") {
    return new URL(config.base_url);
  }
  const origins: Readonly<Record<string, string>> = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
    google: "https://generativelanguage.googleapis.com",
    "openai-codex": "https://chatgpt.com/backend-api/codex",
    "xai-grok": "https://cli-chat-proxy.grok.com/v1",
  };
  const destination = typeof config?.kind === "string" ? origins[config.kind] : undefined;
  if (destination === undefined) {
    throw Object.assign(new Error("provider destination is not fixed by the run snapshot"), {
      code: "unauthorized",
    });
  }
  return new URL(destination);
}

function hostModelBroker(
  input: LocalRuntimeInput,
  args: ExecuteRunArgs,
  runId: string,
  leaseId: string,
  guardSettings: GuardSettings,
): ModelBroker {
  const admitted = runtimeModelPairs(args.rawBody, guardSettings);
  const providers = structuredClone((args.rawBody as RunRequest).providers);
  const brokers = new Map<string, ModelBroker>();
  let revoked = false;
  const brokerFor = (provider: string, model: string): ModelBroker => {
    const key = `${provider}\0${model}`;
    if (revoked || !admitted.has(key))
      throw Object.assign(new Error("model is outside the run snapshot"), { code: "unauthorized" });
    const existing = brokers.get(key);
    if (existing !== undefined) return existing;
    const resolution = resolveProvider(provider, providers, model);
    if (!resolution.ok) {
      throw Object.assign(new Error(resolution.message), { code: resolution.code });
    }
    const modelCapabilities = providers?.find((entry) => entry.name === provider)?.models?.[model]
      ?.capabilities;
    const broker = createModelBroker(
      {
        id: leaseId,
        generation: input.generation,
        runId,
        provider,
        model,
        destination: modelDestination({ providers }, provider),
        expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
        maxConcurrent: args.deps.env.CLARVIS_MAX_CONCURRENT_MODEL_CALLS,
        maxQueued: args.deps.env.CLARVIS_MAX_QUEUED_MODEL_CALLS,
        maxInputBytes: MAX_JSON_MESSAGE_BYTES,
        maxOutputBytes: input.settings.limits.output_bytes,
      },
      (request, authority) => {
        const body = request.body as LLMCallParams;
        assertInlineModelMedia(body.messages);
        return streamHostModelCall(
          args.deps.llm,
          {
            ...body,
            provider: request.provider,
            model: request.model,
            providerConfig: resolution.config,
            capabilities: modelCapabilities === undefined ? undefined : new Set(modelCapabilities),
            signal: authority.signal,
          },
          input.settings.limits.output_bytes,
        );
      },
    );
    brokers.set(key, broker);
    return broker;
  };
  return {
    execute(identity, request, signal, onEvent) {
      return brokerFor(request.provider, request.model).execute(identity, request, signal, onEvent);
    },
    revoke() {
      revoked = true;
      for (const broker of brokers.values()) broker.revoke();
      brokers.clear();
    },
  };
}

/** Validate the closed host-elicitation capability envelope. */
export function validElicitArguments(value: unknown): value is {
  params: ElicitParams;
  timeoutMs?: number;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as { params?: unknown; timeoutMs?: unknown };
  const keys = Object.keys(value);
  return (
    keys.every((key) => key === "params" || key === "timeoutMs") &&
    typeof record.params === "object" &&
    record.params !== null &&
    (record.timeoutMs === undefined ||
      (Number.isSafeInteger(record.timeoutMs) && (record.timeoutMs as number) > 0))
  );
}

/** Validate the closed guest-port preview capability envelope. */
export function validPreviewArguments(value: unknown): value is {
  port: number;
  protocol?: "http" | "https" | "tcp";
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as { port?: unknown; protocol?: unknown };
  const keys = Object.keys(value);
  return (
    keys.every((key) => key === "port" || key === "protocol") &&
    Number.isSafeInteger(input.port) &&
    (input.port as number) >= 1 &&
    (input.port as number) <= 65_535 &&
    (input.protocol === undefined ||
      input.protocol === "http" ||
      input.protocol === "https" ||
      input.protocol === "tcp")
  );
}

function runAllowsCommandExecution(rawBody: unknown): boolean {
  const body = rawBody as { profiles?: Array<{ grants?: unknown }> };
  return (
    Array.isArray(body.profiles) &&
    body.profiles.some(
      (profile) => Array.isArray(profile.grants) && profile.grants.includes("run_commands"),
    )
  );
}

/** Compose shared host authority and lifecycle around one selected container engine. */
export async function createLocalContainerRuntime(
  input: ResolvedLocalRuntimeInput,
  backend: RuntimeBackend,
  router: RuntimeAuthorityRouter,
  options: LocalContainerRuntimeOptions = {},
): Promise<RuntimeHost> {
  const protectedPaths = await readOnlyWorkspacePaths(input);
  const controller = await launchIsolatedRuntime({
    ...input,
    readOnlyWorkspacePaths: protectedPaths,
    capabilityMethods: [
      "runtime.elicit",
      RUNTIME_GUARD_APPROVAL_METHOD,
      RUNTIME_MCP_METHOD,
      RUNTIME_HOOKS_METHOD,
      RUNTIME_WORKFLOWS_METHOD,
      RUNTIME_GOAL_METHOD,
      RUNTIME_PREVIEW_METHOD,
      RUNTIME_HOST_VCS_METHOD,
      ...(input.planFactory === undefined ? [] : [RUNTIME_PLANS_METHOD]),
      ...(input.taskResolver === undefined ? [] : [RUNTIME_TASKS_METHOD]),
      ...(input.skillsProvider === undefined ? [] : [RUNTIME_SKILLS_METHOD]),
      ...(input.memoryFactory === undefined ? [] : [RUNTIME_MEMORY_METHOD]),
    ],
    backend,
  });
  const defaultGuardAllowlist =
    input.sessionAllowlistFor === undefined ? createGuardSessionAllowlist() : undefined;
  interface RunSnapshot {
    readonly leaseId: string;
    readonly toolPolicy: RuntimeToolPolicy;
    readonly loopPolicy: RuntimeLoopPolicy;
    readonly guardSettings: GuardSettings;
    readonly hooks?: RuntimeHooksDescriptor;
    readonly workflow?: RuntimeWorkflowDescriptor;
    readonly workflowContext?: WorkflowCtx;
    readonly goal?: RuntimeGoalDescriptor;
    readonly outputBudgets: ReadonlyArray<{ tokens: number | null; maxParallelSubagents: number }>;
    readonly skillCatalog?: readonly RuntimeSkillCatalogEntry[];
    readonly skillBootstraps?: readonly RuntimeSkillBootstrapEntry[];
    readonly memory?: MemoryRuntimeDescriptor;
  }
  const snapshots = new Map<string, RunSnapshot>();
  const executeRun = createIsolatedRunExecutor({
    generation: input.generation,
    workspaceRoot: input.workspaceRoot,
    session: controller.session,
    router,
    ...(options.roots === undefined ? {} : { roots: options.roots }),
    guestEnvelope: (args, runId) => {
      const snapshot = snapshots.get(runId);
      if (snapshot === undefined) throw new Error("runtime run snapshot was not prepared");
      const raw = args.rawBody as { continue_from?: unknown };
      return {
        modelLeaseId: snapshot.leaseId,
        toolPolicy: snapshot.toolPolicy,
        loopPolicy: snapshot.loopPolicy,
        hostCapabilities: [
          ...(input.planFactory === undefined ? [] : ["plans"]),
          ...(input.taskResolver === undefined ? [] : ["tasks"]),
          ...(snapshot.skillCatalog === undefined ? [] : ["skills"]),
          ...(snapshot.memory === undefined ? [] : ["memory"]),
          ...(snapshot.goal === undefined ? [] : ["goal"]),
          ...(snapshot.toolPolicy.enabled &&
          snapshot.toolPolicy.maxGrant === "exec" &&
          runAllowsCommandExecution(args.rawBody)
            ? ["host_vcs"]
            : []),
        ],
        ...(snapshot.skillCatalog === undefined
          ? {}
          : {
              skillCatalog: snapshot.skillCatalog,
              skillBootstraps: snapshot.skillBootstraps ?? [],
            }),
        ...(snapshot.memory === undefined ? {} : { memory: snapshot.memory }),
        ...(snapshot.goal === undefined ? {} : { goal: snapshot.goal }),
        guardSettings: snapshot.guardSettings,
        ...(snapshot.hooks === undefined ? {} : { hooks: snapshot.hooks }),
        ...(snapshot.workflow === undefined ? {} : { workflow: snapshot.workflow }),
        ...(args.runtimeParentRunId === undefined ? {} : { parentRunId: args.runtimeParentRunId }),
        outputBudgets: snapshot.outputBudgets,
        ...(typeof raw.continue_from === "string"
          ? { priorExecution: args.deps.traceStore.getById(args.owner, raw.continue_from) }
          : {}),
      };
    },
    authority: async (args, runId) => {
      const admittedCapabilities = [
        ...(args.deps.capabilities ?? []),
        ...(args.capabilities ?? []),
      ];
      const toolPolicy: RuntimeToolPolicy = {
        enabled:
          args.deps.env.CLARVIS_AGENT_TOOLS_ENABLED &&
          admittedCapabilities.some((capability) => capability.name === "tools"),
        confine: args.deps.env.CLARVIS_AGENT_TOOLS_CONFINE,
        maxGrant: args.deps.env.CLARVIS_AGENT_TOOLS_MAX_GRANT,
      };
      const hostVcsEnabled =
        toolPolicy.enabled &&
        toolPolicy.maxGrant === "exec" &&
        runAllowsCommandExecution(args.rawBody);
      const workflowContext = admittedCapabilities
        .map(workflowContextOf)
        .find((context) => context !== undefined);
      const goalPorts = admittedCapabilities.flatMap((capability) => {
        const port = goalRuntimePortOf(capability);
        return port === undefined ? [] : [port];
      });
      if (
        goalPorts.length > 1 ||
        (goalPorts.length > 0 &&
          (workflowContext !== undefined ||
            args.runtimeParentRunId !== undefined ||
            (args.rawBody as RunRequest).profiles.some((profile) =>
              profile.grants?.includes("workflow"),
            )))
      )
        throw new RuntimeLaunchError(
          "unsupported_policy",
          "Goal requires one ordinary entry capability",
        );
      const goal =
        goalPorts[0] === undefined
          ? undefined
          : createHostGoalBridge(goalPorts[0], args.rawBody, runId);
      for (const capability of admittedCapabilities) {
        if (
          ![
            "hooks",
            "tools",
            "ask-user",
            "skills",
            "plans",
            "memory",
            "tasks",
            "delegation",
          ].includes(capability.name) &&
          workflowContextOf(capability) === undefined &&
          goalRuntimePortOf(capability) === undefined &&
          workflowOutputBudgetOf(capability) === undefined
        ) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            `runtime cannot preserve capability '${capability.name}'`,
          );
        }
      }
      const workflow =
        workflowContext === undefined
          ? undefined
          : createHostWorkflowBridge(workflowContext, executeRun);
      const outputBudgets = admittedCapabilities.flatMap((capability) => {
        const budget = workflowOutputBudgetOf(capability);
        if (budget === undefined) return [];
        const remaining = budget.outputBudget.remaining();
        return [
          {
            tokens: Number.isFinite(remaining) ? remaining : null,
            maxParallelSubagents: budget.maxParallelSubagents,
          },
        ];
      });
      const leaseId = randomUUID();
      const hooks = await createHostHooksBridge(args, runId, (call, signal) =>
        controller.session.callHookMcp(runId, call, signal),
      );
      const loadedGuardSettings = structuredClone(input.loadGuardSettings?.() ?? {});
      const guardSettings: GuardSettings = structuredClone({
        ...(loadedGuardSettings.guard === undefined ? {} : { guard: loadedGuardSettings.guard }),
        defaultModel:
          loadedGuardSettings.defaultModel ??
          (args.deps.env as { CLARVIS_DEFAULT_MODEL?: string }).CLARVIS_DEFAULT_MODEL,
      });
      const model = hostModelBroker(input, args, runId, leaseId, guardSettings);
      const hostGuardResolution = hostVcsEnabled
        ? createGuardRuntimeResolver({
            loadSettings: () => loadedGuardSettings,
            logger: input.deps.logger,
            ...(input.guardAudit === undefined ? {} : { audit: input.guardAudit }),
            sessionAllowlistFor: ({ executionId, owner }) =>
              input.sessionAllowlistFor === undefined
                ? defaultGuardAllowlist
                : input.sessionAllowlistFor({ executionId, owner }),
          })({
            request: args.rawBody as RunRequest,
            owner: args.owner,
            env: args.deps.env,
            workspaceRoot: input.workspaceRoot,
            llm: args.deps.llm,
            ...(args.elicit === undefined ? {} : { elicit: args.elicit }),
            logger: args.deps.logger,
            ...(args.externalSignal === undefined ? {} : { signal: args.externalSignal }),
            executionId: runId,
          })
        : undefined;
      const hostGuardElicit =
        hostGuardResolution?.elicit === undefined
          ? undefined
          : withGuardElicitWaitBound(
              hostGuardResolution.elicit,
              (args.rawBody as RunRequest).elicit_wait_ms ??
                args.deps.env.CLARVIS_DEFAULT_ELICIT_WAIT_MS,
              args.externalSignal,
            );
      const skillCatalog =
        input.skillsProvider === undefined
          ? undefined
          : createRuntimeSkillCatalog(input.skillsProvider);
      const skillBootstraps =
        input.skillsProvider === undefined
          ? undefined
          : createRuntimeSkillBootstraps(
              input.skillsProvider,
              input.skillBootstraps,
              input.deps.logger,
            );
      const memory =
        input.memoryFactory === undefined
          ? undefined
          : await createHostMemoryBridge({
              factory: input.memoryFactory,
              rawBody: args.rawBody,
              owner: args.owner,
              runId,
              deps: args.deps,
              ...(args.externalSignal === undefined ? {} : { signal: args.externalSignal }),
              ...(args.onCapabilityEvent === undefined
                ? {}
                : { onCapabilityEvent: args.onCapabilityEvent }),
            });
      const remoteMcp = createHostRemoteMcpBridge({
        servers: (args.rawBody as RunRequest).servers ?? [],
        owner: args.owner,
        connections: args.deps.connections,
        maxLeases: args.deps.env.CLARVIS_MCP_MAX_CONNECTIONS,
        elicit: (input, signal) => controller.session.elicitMcp(runId, input, signal),
      });
      const capabilities = createCapabilityBroker({
        generation: input.generation,
        runId,
        grants: [
          createHostGuardApprovalGrant({
            elicit: args.elicit,
            allowlist: () =>
              input.sessionAllowlistFor === undefined
                ? defaultGuardAllowlist
                : input.sessionAllowlistFor({ executionId: runId, owner: args.owner }),
            workspaceRoot: input.workspaceRoot,
          }),
          remoteMcp.grant,
          {
            method: "runtime.elicit",
            revision: "v1",
            idempotent: false,
            validateArguments: validElicitArguments,
            async invoke(value, signal): Promise<ElicitRawResult> {
              if (!validElicitArguments(value) || args.elicit === undefined) {
                return { action: "cancel" };
              }
              return args.elicit(value.params, { signal, timeoutMs: value.timeoutMs });
            },
          },
          ...(hostVcsEnabled
            ? [
                createHostVcsGrant({
                  workspaceRoot: input.workspaceRoot,
                  ...(input.deps.logger === undefined ? {} : { logger: input.deps.logger }),
                  ...(hostGuardResolution?.guard === undefined
                    ? {}
                    : { guard: hostGuardResolution.guard }),
                  ...(hostGuardElicit === undefined ? {} : { elicit: hostGuardElicit }),
                  secretEnvNames: input.loadSecretNames?.() ?? [],
                }),
                {
                  method: RUNTIME_PREVIEW_METHOD,
                  revision: RUNTIME_PREVIEW_REVISION,
                  idempotent: true,
                  validateArguments: validPreviewArguments,
                  async invoke(value: unknown, signal: AbortSignal) {
                    if (!validPreviewArguments(value)) {
                      throw Object.assign(new Error("runtime preview arguments are invalid"), {
                        code: "invalid_request",
                      });
                    }
                    return controller.session.exposePort(value.port, value.protocol, signal);
                  },
                },
              ]
            : []),
          ...(input.planFactory === undefined
            ? []
            : [
                createHostPlansGrant(input.planFactory, args.owner, {
                  runId,
                  priorRef: planRefFromCapabilityState(
                    typeof (args.rawBody as RunRequest).continue_from === "string"
                      ? args.deps.traceStore.getById(
                          args.owner,
                          (args.rawBody as RunRequest).continue_from!,
                        )?.capability_state
                      : undefined,
                  ),
                  readTerminalRecord: () => args.deps.traceStore.getById(args.owner, runId),
                }),
              ]),
          ...(input.taskResolver === undefined
            ? []
            : [
                createHostTasksGrant(
                  input.taskResolver,
                  args.owner,
                  runId,
                  args.rawBody,
                  typeof (args.rawBody as RunRequest).continue_from === "string"
                    ? args.deps.traceStore.getById(
                        args.owner,
                        (args.rawBody as RunRequest).continue_from!,
                      )?.capability_state?.tasks
                    : undefined,
                ),
              ]),
          ...(input.skillsProvider === undefined
            ? []
            : [createHostSkillsGrant(input.skillsProvider, skillCatalog ?? [])]),
          ...(memory === undefined ? [] : [memory.grant]),
          ...(hooks === undefined ? [] : [hooks.grant]),
          ...(workflow === undefined ? [] : [workflow.grant]),
          ...(goal === undefined ? [] : [goal.grant]),
        ],
        maxArgumentsBytes: goal === undefined ? 256 * 1024 : RUNTIME_GOAL_MAX_BYTES,
        maxResultBytes: goal === undefined ? 256 * 1024 : RUNTIME_GOAL_MAX_BYTES,
      });
      snapshots.set(runId, {
        leaseId,
        toolPolicy,
        loopPolicy: runtimeLoopPolicy(args.deps.env),
        guardSettings,
        ...(hooks === undefined ? {} : { hooks: hooks.descriptor }),
        ...(workflow === undefined ? {} : { workflow: workflow.descriptor }),
        ...(workflowContext === undefined ? {} : { workflowContext }),
        ...(goal === undefined ? {} : { goal: goal.descriptor }),
        outputBudgets,
        ...(skillCatalog === undefined ? {} : { skillCatalog }),
        ...(skillBootstraps === undefined ? {} : { skillBootstraps }),
        ...(memory === undefined ? {} : { memory: memory.descriptor }),
      });
      return {
        model,
        capabilities,
        terminalParticipants: () => [
          { name: "session", async commit() {} },
          {
            name: "trace",
            async commit() {
              if (!args.deps.traceStore.existsForOwner(args.owner, runId)) {
                throw new Error("runtime trace is not durable on the host");
              }
            },
          },
          { name: "capabilities", async commit() {} },
        ],
        async dispose() {
          snapshots.delete(runId);
          await remoteMcp.dispose();
        },
      };
    },
    consumeGuestEvent: (args, runId, value) =>
      consumeGuestWorkflowEvent(snapshots.get(runId)?.workflowContext, value) ||
      forwardGuestGuardAudit(value, input.guardAudit ?? NOOP_LOGGER, runId, args.owner),
  });
  return {
    executeRun,
    info: controller.info,
    get closed() {
      return controller.session.closed;
    },
    async close() {
      snapshots.clear();
      await controller.close();
    },
  };
}
