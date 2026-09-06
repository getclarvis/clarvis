import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { NOOP_LOGGER } from "@clarvis/capability";
import type { ElicitParams, ElicitRawResult, ExecuteRunArgs, LLMCallParams } from "@clarvis/loop";
import type { RuntimeHost, RuntimeHostInput } from "./lazy-runtime.ts";
import type { ResolvedContainerRuntimeSettings } from "./settings.ts";
import { createNodePodmanControl } from "../adapters/process/node-podman-control.ts";
import {
  createCapabilityBroker,
  createModelBroker,
  type ModelBroker,
} from "./authority-brokers.ts";
import {
  createIsolatedRunExecutor,
  createRuntimeAuthorityRouter,
  type RuntimeAuthorityRouter,
} from "./isolated-run-executor.ts";
import { createPodmanRuntimeBackend } from "./podman-backend.ts";
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
import type { PodmanControl } from "./podman-backend.ts";
import { launchIsolatedRuntime } from "./runtime-controller.ts";
import {
  agentsPluginsDir,
  agentsSkillsDirs,
  workspacePaths,
  type RootOptions,
} from "@clarvis/paths";
import { RuntimeLaunchError, type RuntimeBackend } from "./types.ts";
import { prepareRuntimeCapabilityRoot } from "./runtime-workspace-control.ts";

type LocalRuntimeInput = RuntimeHostInput;
type ResolvedLocalRuntimeInput = Omit<LocalRuntimeInput, "settings"> & {
  readonly settings: ResolvedContainerRuntimeSettings;
};

/** Deterministic host-effect seams for the local composition contract tests. */
export interface LocalPodmanRuntimeOptions {
  readonly control?: PodmanControl;
  readonly roots?: RootOptions;
}

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

function modelPairs(rawBody: unknown): Set<string> {
  const raw = rawBody as { profiles?: Array<{ model?: unknown }> };
  const pairs = new Set<string>();
  for (const profile of raw.profiles ?? []) {
    if (typeof profile.model !== "string") continue;
    const slash = profile.model.indexOf("/");
    if (slash > 0 && slash < profile.model.length - 1) {
      pairs.add(`${profile.model.slice(0, slash)}\0${profile.model.slice(slash + 1)}`);
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
): ModelBroker {
  const admitted = modelPairs(args.rawBody);
  const brokers = new Map<string, ModelBroker>();
  const brokerFor = (provider: string, model: string): ModelBroker => {
    const key = `${provider}\0${model}`;
    if (!admitted.has(key))
      throw Object.assign(new Error("model is outside the run snapshot"), { code: "unauthorized" });
    const existing = brokers.get(key);
    if (existing !== undefined) return existing;
    const broker = createModelBroker(
      {
        id: leaseId,
        generation: input.generation,
        runId,
        provider,
        model,
        destination: modelDestination(args.rawBody, provider),
        expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
        maxConcurrent: Math.max(1, Math.floor(input.settings.limits.cpu_count)),
        maxInputBytes: input.settings.limits.output_bytes,
        maxOutputBytes: input.settings.limits.output_bytes,
      },
      async function* (request, authority) {
        const body = request.body as LLMCallParams;
        const deltas: unknown[] = [];
        const result = await args.deps.llm.call({
          ...body,
          provider: request.provider,
          model: request.model,
          providerConfig: providerConfig(
            args.rawBody,
            request.provider,
          ) as LLMCallParams["providerConfig"],
          signal: authority.signal,
          onStreamDelta: (delta) => deltas.push({ type: "stream", ...delta }),
        });
        for (const delta of deltas) yield delta;
        yield { type: "result", result };
      },
    );
    brokers.set(key, broker);
    return broker;
  };
  return {
    execute(identity, request, signal) {
      return brokerFor(request.provider, request.model).execute(identity, request, signal);
    },
    revoke() {
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

/** Compose the concrete local Podman backend only after the host selected it. */
export async function createLocalPodmanRuntime(
  input: LocalRuntimeInput,
  options: LocalPodmanRuntimeOptions = {},
): Promise<RuntimeHost> {
  if (input.settings.backend !== "podman") {
    throw new Error("Podman runtime composition requires backend: podman");
  }
  const router = createRuntimeAuthorityRouter(input.generation);
  const environment = Object.fromEntries(
    ["HOME", "PATH", "XDG_RUNTIME_DIR"].flatMap((name) => {
      const value = process.env[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
  const backend = createPodmanRuntimeBackend({
    control:
      options.control ??
      createNodePodmanControl({
        executable: input.settings.executable,
        connection: input.settings.connection,
        environment,
      }),
    handlers: router.handlers,
  });
  const resolvedInput: ResolvedLocalRuntimeInput = { ...input, settings: input.settings };
  return createLocalContainerRuntime(resolvedInput, backend, router, options);
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
      RUNTIME_PREVIEW_METHOD,
      ...(input.planFactory === undefined ? [] : [RUNTIME_PLANS_METHOD]),
      ...(input.skillsProvider === undefined ? [] : [RUNTIME_SKILLS_METHOD]),
      ...(input.memoryFactory === undefined ? [] : [RUNTIME_MEMORY_METHOD]),
    ],
    backend,
  });
  interface RunSnapshot {
    readonly leaseId: string;
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
        hostCapabilities: [
          ...(input.planFactory === undefined ? [] : ["plans"]),
          ...(snapshot.skillCatalog === undefined ? [] : ["skills"]),
          ...(snapshot.memory === undefined ? [] : ["memory"]),
        ],
        ...(snapshot.skillCatalog === undefined
          ? {}
          : {
              skillCatalog: snapshot.skillCatalog,
              skillBootstraps: snapshot.skillBootstraps ?? [],
            }),
        ...(snapshot.memory === undefined ? {} : { memory: snapshot.memory }),
        guardSettings: (() => {
          const settings = input.loadGuardSettings?.() ?? {};
          return {
            ...(settings.guard === undefined ? {} : { guard: settings.guard }),
            ...(settings.defaultModel === undefined ? {} : { defaultModel: settings.defaultModel }),
          };
        })(),
        ...(typeof raw.continue_from === "string"
          ? { priorExecution: args.deps.traceStore.getById(args.owner, raw.continue_from) }
          : {}),
      };
    },
    authority: async (args, runId) => {
      const leaseId = randomUUID();
      const model = hostModelBroker(input, args, runId, leaseId);
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
      snapshots.set(runId, {
        leaseId,
        ...(skillCatalog === undefined ? {} : { skillCatalog }),
        ...(skillBootstraps === undefined ? {} : { skillBootstraps }),
        ...(memory === undefined ? {} : { memory: memory.descriptor }),
      });
      const capabilities = createCapabilityBroker({
        generation: input.generation,
        runId,
        grants: [
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
          ...(runAllowsCommandExecution(args.rawBody)
            ? [
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
            : [createHostPlansGrant(input.planFactory, args.owner)]),
          ...(input.skillsProvider === undefined
            ? []
            : [createHostSkillsGrant(input.skillsProvider, skillCatalog ?? [])]),
          ...(memory === undefined ? [] : [memory.grant]),
        ],
        maxArgumentsBytes: 256 * 1024,
        maxResultBytes: 256 * 1024,
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
        dispose() {
          snapshots.delete(runId);
        },
      };
    },
    consumeGuestEvent: (args, runId, value) =>
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
