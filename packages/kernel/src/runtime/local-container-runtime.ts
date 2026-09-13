import { randomUUID } from "node:crypto";
import { MAX_JSON_MESSAGE_BYTES } from "../core/json-message.ts";
import type { RuntimeToolPolicy } from "./tool-policy.ts";
import { runtimeLoopPolicy, type RuntimeLoopPolicy } from "./loop-policy.ts";
import type { Stats } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveProvider, type RunRequest } from "@clarvis/capability";
import type { ElicitParams, ElicitRawResult, ExecuteRunArgs, LLMCallParams } from "@clarvis/loop";
import type { RuntimeHost, RuntimeHostInput } from "./lazy-runtime.ts";
import type { ResolvedContainerRuntimeSettings } from "./settings.ts";
import {
  createCapabilityBroker,
  createModelBroker,
  type ModelBroker,
} from "./authority-brokers.ts";
import { createIsolatedRunExecutor, type RuntimeAuthorityRouter } from "./isolated-run-executor.ts";
import { launchIsolatedRuntime } from "./runtime-controller.ts";
import { agentsWorkspaceDir, workspacePaths, type RootOptions } from "@clarvis/paths";
import { RuntimeLaunchError, type RuntimeBackend, type RuntimeProtectedMount } from "./types.ts";
import { streamHostModelCall } from "./model-stream.ts";
import { assertInlineModelMedia } from "./model-media.ts";
import {
  CONTAINER_CORE_CAPABILITY_METHODS,
  assertContainerCoreRuntimeRequest,
  containerCorePolicy,
} from "./container-core-policy.ts";

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

interface PreparedRuntimeMounts {
  readonly controlRootMasks: readonly RuntimeProtectedMount[];
  readonly gitMetadataMounts: readonly RuntimeProtectedMount[];
  cleanup(): Promise<void>;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
  if (!isAbsolute(path) || resolve(path) === resolve(path, "..")) {
    throw new RuntimeLaunchError(
      "unsupported_policy",
      `${label} must be an absolute non-root path`,
    );
  }
  const canonical = await realpath(path).catch((cause: unknown) => {
    throw new RuntimeLaunchError("unsupported_policy", `${label} is unavailable`, { cause });
  });
  const info = await lstat(canonical);
  if (!info.isDirectory()) {
    throw new RuntimeLaunchError("unsupported_policy", `${label} must be a directory`);
  }
  return canonical;
}

/** Prepare opaque control masks and the exact read-only Git metadata projection. */
export async function prepareRuntimeMounts(
  input: ResolvedLocalRuntimeInput,
): Promise<PreparedRuntimeMounts> {
  const workspaceRoot = resolve(input.workspaceRoot);
  const paths = workspacePaths(workspaceRoot);
  const agentsRoot = agentsWorkspaceDir(workspaceRoot);
  for (const controlRoot of [paths.clarvisDir, agentsRoot]) {
    const info = await inspectReservedWorkspacePath(controlRoot, workspaceRoot);
    if (info !== undefined && !info.isDirectory()) {
      throw new RuntimeLaunchError(
        "unsupported_policy",
        `reserved workspace path '${controlRoot}' must be a directory`,
      );
    }
  }
  const createdRoot = await mkdtemp(join(tmpdir(), "clarvis-container-masks-"));
  const privateRoot = await realpath(createdRoot);
  try {
    const fromWorkspace = relative(workspaceRoot, privateRoot);
    if (
      fromWorkspace === "" ||
      (fromWorkspace !== ".." &&
        !fromWorkspace.startsWith(`..${sep}`) &&
        !isAbsolute(fromWorkspace))
    ) {
      throw new RuntimeLaunchError(
        "unsupported_policy",
        "runtime control masks must be outside the selected workspace",
      );
    }
    const clarvisMask = join(privateRoot, "clarvis");
    const agentsMask = join(privateRoot, "agents");
    const gitMask = join(privateRoot, "git");
    await Promise.all(
      [clarvisMask, agentsMask, gitMask].map((path) => mkdir(path, { mode: 0o700 })),
    );
    const guestPaths = workspacePaths("/workspace");
    const controlRootMasks: readonly RuntimeProtectedMount[] = [
      {
        source: clarvisMask,
        target: guestPaths.clarvisDir,
        type: "directory",
        readOnly: true,
      },
      {
        source: agentsMask,
        target: agentsWorkspaceDir("/workspace"),
        type: "directory",
        readOnly: true,
      },
    ];
    const dotGit = join(workspaceRoot, ".git");
    const dotGitInfo = await inspectReservedWorkspacePath(dotGit, workspaceRoot);
    let gitMetadataMounts: readonly RuntimeProtectedMount[];
    if (input.gitMetadataMounts.length === 0) {
      if (dotGitInfo !== undefined) {
        throw new RuntimeLaunchError(
          "unsupported_policy",
          "workspace Git metadata was not admitted by host discovery",
        );
      }
      gitMetadataMounts = [
        { source: gitMask, target: "/workspace/.git", type: "directory", readOnly: true },
      ];
    } else {
      if (dotGitInfo === undefined) {
        throw new RuntimeLaunchError(
          "unsupported_policy",
          "workspace Git metadata discovery is incomplete",
        );
      }
      let expected: readonly RuntimeProtectedMount[];
      if (input.workspace.kind === "external_worktree") {
        if (!dotGitInfo.isFile()) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "linked worktree .git metadata must be a regular file",
          );
        }
        const indirection = (await readFile(dotGit, "utf8")).trim();
        const declaredGitDir = indirection.startsWith("gitdir: ")
          ? indirection.slice("gitdir: ".length)
          : "";
        if (!isAbsolute(declaredGitDir)) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "linked worktree .git indirection must name the admitted canonical Git directory",
          );
        }
        const gitDir = await canonicalDirectory(declaredGitDir, "runtime Git directory");
        const commonReference = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
        if (commonReference.length === 0) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "linked worktree common Git directory does not match host discovery",
          );
        }
        const commonDir = await canonicalDirectory(
          resolve(gitDir, commonReference),
          "runtime Git common directory",
        );
        expected = [
          { source: dotGit, target: "/workspace/.git", type: "file", readOnly: true },
          { source: gitDir, target: gitDir, type: "directory", readOnly: true },
          ...(commonDir === gitDir
            ? []
            : [
                {
                  source: commonDir,
                  target: commonDir,
                  type: "directory" as const,
                  readOnly: true as const,
                },
              ]),
        ];
      } else {
        if (!dotGitInfo.isDirectory()) {
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "primary checkout Git metadata does not match host discovery",
          );
        }
        const gitDir = await canonicalDirectory(dotGit, "runtime Git directory");
        expected = [
          { source: gitDir, target: "/workspace/.git", type: "directory", readOnly: true },
        ];
      }
      if (
        input.gitMetadataMounts.length !== expected.length ||
        input.gitMetadataMounts.some((mount, index) => {
          const wanted = expected[index];
          return (
            wanted === undefined ||
            mount.source !== wanted.source ||
            mount.target !== wanted.target ||
            mount.type !== wanted.type ||
            mount.readOnly !== true
          );
        })
      ) {
        throw new RuntimeLaunchError(
          "unsupported_policy",
          "runtime Git metadata mounts do not match host discovery",
        );
      }
      gitMetadataMounts = expected;
    }
    return {
      controlRootMasks,
      gitMetadataMounts,
      cleanup: async () => rm(privateRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(privateRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Exact models the assembled request can use, including its resolved auxiliary paths. */
export function runtimeModelPairs(rawBody: unknown): Set<string> {
  const raw = rawBody as {
    profiles?: Array<{ model?: unknown }>;
    vision_model?: unknown;
  };
  const pairs = new Set<string>();
  const models = [...(raw.profiles ?? []).map((profile) => profile.model), raw.vision_model];
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

/** Project only provider routing names into the guest; host configuration and credentials stay host-side. */
export function containerGuestRawBody(rawBody: unknown): unknown {
  if (typeof rawBody !== "object" || rawBody === null || Array.isArray(rawBody)) {
    throw new RuntimeLaunchError("unsupported_policy", "Container run request is invalid");
  }
  const body = structuredClone(rawBody) as Record<string, unknown>;
  const providers = Array.isArray(body.providers) ? body.providers : [];
  body.providers = providers.flatMap((candidate) => {
    if (typeof candidate !== "object" || candidate === null) return [];
    const name = (candidate as { name?: unknown }).name;
    return typeof name === "string"
      ? [
          {
            name,
            kind: "openai-compatible" as const,
            base_url: "http://runtime-model-broker.invalid",
          },
        ]
      : [];
  });
  return body;
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
  const admitted = runtimeModelPairs(args.rawBody);
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
  if (typeof record.params !== "object" || record.params === null || Array.isArray(record.params))
    return false;
  const params = record.params as {
    message?: unknown;
    requestedSchema?: unknown;
    kind?: unknown;
  };
  if (
    !Object.keys(params).every((key) => ["message", "requestedSchema", "kind"].includes(key)) ||
    typeof params.message !== "string" ||
    params.message.length === 0 ||
    params.message.length > 16 * 1024 ||
    (params.kind !== undefined && params.kind !== "ask_user") ||
    typeof params.requestedSchema !== "object" ||
    params.requestedSchema === null ||
    Array.isArray(params.requestedSchema)
  )
    return false;
  const schema = params.requestedSchema as {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
  };
  if (
    !Object.keys(schema).every((key) => ["type", "properties", "required"].includes(key)) ||
    schema.type !== "object" ||
    typeof schema.properties !== "object" ||
    schema.properties === null ||
    Array.isArray(schema.properties) ||
    !Array.isArray(schema.required)
  )
    return false;
  const properties = Object.entries(schema.properties as Record<string, unknown>);
  const required = schema.required;
  if (
    properties.length === 0 ||
    properties.length > 16 ||
    required.some((name) => typeof name !== "string") ||
    new Set(required).size !== required.length ||
    required.some((name) => !Object.hasOwn(schema.properties as object, name as PropertyKey))
  )
    return false;
  if (
    properties.some(([, candidate]) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
        return true;
      const field = candidate as { type?: unknown; enum?: unknown; description?: unknown };
      return (
        !Object.keys(field).every((key) => ["type", "enum", "description"].includes(key)) ||
        field.type !== "string" ||
        (field.description !== undefined && typeof field.description !== "string") ||
        (field.enum !== undefined &&
          (!Array.isArray(field.enum) ||
            field.enum.length === 0 ||
            field.enum.length > 64 ||
            field.enum.some((option) => typeof option !== "string")))
      );
    })
  )
    return false;
  return (
    keys.every((key) => key === "params" || key === "timeoutMs") &&
    (record.timeoutMs === undefined ||
      (Number.isSafeInteger(record.timeoutMs) && (record.timeoutMs as number) > 0))
  );
}

/** Compose shared host authority and lifecycle around one selected container engine. */
export async function createLocalContainerRuntime(
  input: ResolvedLocalRuntimeInput,
  backend: RuntimeBackend,
  router: RuntimeAuthorityRouter,
  options: LocalContainerRuntimeOptions = {},
): Promise<RuntimeHost> {
  const mounts = await prepareRuntimeMounts(input);
  let controller: Awaited<ReturnType<typeof launchIsolatedRuntime>>;
  try {
    controller = await launchIsolatedRuntime({
      ...input,
      controlRootMasks: mounts.controlRootMasks,
      gitMetadataMounts: mounts.gitMetadataMounts,
      capabilityMethods: CONTAINER_CORE_CAPABILITY_METHODS,
      backend,
    });
  } catch (error) {
    await mounts.cleanup();
    throw error;
  }
  interface RunSnapshot {
    readonly leaseId: string;
    readonly toolPolicy: RuntimeToolPolicy;
    readonly loopPolicy: RuntimeLoopPolicy;
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
      const priorExecution =
        typeof raw.continue_from === "string"
          ? args.deps.traceStore.getById(args.owner, raw.continue_from)
          : undefined;
      const guestPrior =
        priorExecution === undefined || priorExecution === null
          ? undefined
          : Object.fromEntries(
              Object.entries(priorExecution).filter(
                ([key]) => key !== "operator_authority_state" && key !== "capability_state",
              ),
            );
      return {
        rawBody: containerGuestRawBody(args.rawBody),
        modelLeaseId: snapshot.leaseId,
        toolPolicy: snapshot.toolPolicy,
        loopPolicy: snapshot.loopPolicy,
        ...(guestPrior === undefined ? {} : { priorExecution: guestPrior }),
      };
    },
    authority: async (args, runId) => {
      assertContainerCoreRuntimeRequest(args.rawBody);
      const toolPolicy: RuntimeToolPolicy = {
        enabled: args.deps.env.CLARVIS_AGENT_TOOLS_ENABLED,
        confine: args.deps.env.CLARVIS_AGENT_TOOLS_CONFINE,
        maxGrant: args.deps.env.CLARVIS_AGENT_TOOLS_MAX_GRANT,
      };
      const policy = containerCorePolicy({
        toolPolicy,
        network: input.settings.network === "none" ? "none" : "outbound",
        gitMetadata: input.gitMetadataMounts.length === 0 ? "absent" : "read-only",
      });
      const leaseId = randomUUID();
      const model = hostModelBroker(input, args, runId, leaseId);
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
        ],
        maxArgumentsBytes: 256 * 1024,
        maxResultBytes: 256 * 1024,
      });
      snapshots.set(runId, {
        leaseId,
        toolPolicy: policy.toolPolicy,
        loopPolicy: runtimeLoopPolicy(args.deps.env),
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
  });
  return {
    executeRun,
    info: controller.info,
    get closed() {
      return controller.session.closed;
    },
    async close() {
      snapshots.clear();
      try {
        await controller.close();
      } finally {
        await mounts.cleanup();
      }
    },
  };
}
