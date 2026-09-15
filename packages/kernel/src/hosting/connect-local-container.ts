import { randomUUID, createHash } from "node:crypto";
import { open, readFile, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { envSchema, type Logger } from "@clarvis/capability";
import {
  acquireLocalLease,
  containerLaunchPaths,
  globalPaths,
  type LocalLease,
} from "@clarvis/paths";
import type { RuntimeConfig } from "@clarvis/protocol";
import { createNodeDockerControl } from "../adapters/process/node-docker-control.ts";
import { createNodePodmanControl } from "../adapters/process/node-podman-control.ts";
import { createNodeProcessRunner } from "../adapters/process/node-process-runner.ts";
import { discoverGitWorkspace, runtimeGitMetadataMounts } from "../git-workspace.ts";
import { kernelError } from "../core/errors.ts";
import { createOperatorServices } from "../config/operator-services.ts";
import { projectContainerHostConfiguration } from "../config/project-container-host.ts";
import { createDockerKernelBackend } from "../runtime/docker-backend.ts";
import { createPodmanKernelBackend } from "../runtime/podman-backend.ts";
import { runContainerPreparer } from "../runtime/container-preparer.ts";
import {
  migrateContainerDomainState,
  prepareContainerVolumes,
  resolveContainerVolumeIdentity,
  type ContainerVolumePreparer,
} from "../runtime/container-volumes.ts";
import { prepareContainerDomainMounts, prepareRuntimeMounts } from "../runtime/container-mounts.ts";
import {
  resolveContainerImageDigest,
  type ContainerBaseImageSelection,
} from "../runtime/runtime-image.ts";
import { resolveDockerRuntimeRecipe } from "../runtime/runtime-recipe.ts";
import {
  cacheRuntimeArtifact,
  prepareRuntimeArtifactVolume,
  type RuntimeArtifactSelection,
  type RuntimeArtifactSource,
} from "../runtime/runtime-artifact.ts";
import type { ContainerControl, RuntimeLimits } from "../runtime/types.ts";
import { runtimeSettingsSchema } from "../runtime/settings.ts";
import { launchContainerKernel, type LaunchedContainerKernel } from "./container-host-launcher.ts";

export interface LocalContainerReleaseSelection {
  readonly base: ContainerBaseImageSelection;
  readonly artifact: {
    readonly source: RuntimeArtifactSource;
    readonly selection: RuntimeArtifactSelection;
  };
}

/** Observable host-side phase of one local Container connection attempt. */
export type ContainerConnectionPhase =
  | "inspecting_engine"
  | "resolving_runtime"
  | "inspecting_workspace"
  | "preparing_workspace"
  | "preparing_artifact"
  | "preparing_state"
  | "starting_kernel";

export interface ConnectLocalContainerKernelOptions {
  readonly workspaceRoot: string;
  readonly globalDir: string;
  readonly owner: string;
  readonly runtime: Exclude<RuntimeConfig, { backend: "native" }>;
  readonly release?: LocalContainerReleaseSelection;
  readonly resolveRelease?: (
    target: "linux-x64" | "linux-arm64",
    signal?: AbortSignal,
  ) => Promise<LocalContainerReleaseSelection>;
  readonly logger?: Logger;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
  readonly onProgress?: (phase: ContainerConnectionPhase) => void;
  /** Explicit operator decision to retire the exact currently registered Kernel generation. */
  readonly ownershipConflict?: "refuse" | "terminate";
}

/** @internal Typed effect seams for deterministic orchestration tests; production supplies none. */
export interface LocalContainerConnectorPorts {
  readonly discoverWorkspace?: typeof discoverGitWorkspace;
  readonly resolveVolumeIdentity?: typeof resolveContainerVolumeIdentity;
  readonly acquireLease?: typeof acquireLocalLease;
  readonly prepareMounts?: typeof prepareRuntimeMounts;
  readonly prepareDomainMounts?: typeof prepareContainerDomainMounts;
  readonly createOperator?: typeof createOperatorServices;
  readonly verifyWorkspace?: typeof verifySharedWorkspace;
  readonly cacheArtifact?: typeof cacheRuntimeArtifact;
  readonly prepareVolumes?: typeof prepareContainerVolumes;
  readonly migrateDomainState?: typeof migrateContainerDomainState;
  readonly prepareArtifactVolume?: typeof prepareRuntimeArtifactVolume;
  readonly projectConfiguration?: typeof projectContainerHostConfiguration;
  readonly prepareMise?: typeof prepareMiseVolume;
  readonly createBackend?: (
    engine: "docker" | "podman",
    control: ContainerControl,
    signal?: AbortSignal,
  ) => ReturnType<typeof createDockerKernelBackend>;
  readonly launch?: typeof launchContainerKernel;
}

/** @internal Engine inspection seam kept module-local to the Container connector package entry. */
export async function engineTarget(
  control: ContainerControl,
  engine: "docker" | "podman",
  signal?: AbortSignal,
): Promise<"linux-x64" | "linux-arm64"> {
  const result = await control.run(
    engine === "docker" ? ["info", "--format", "{{json .}}"] : ["info", "--format", "json"],
    signal,
  );
  if (result.exitCode !== 0) throw kernelError("unavailable", `${engine} is not ready`);
  let value: unknown;
  try {
    value = JSON.parse(result.stdout) as unknown;
  } catch {
    throw kernelError("unsupported", `${engine} returned invalid platform information`);
  }
  const root = value as Record<string, unknown>;
  const host = root.host as Record<string, unknown> | undefined;
  const architecture = engine === "docker" ? root.Architecture : host?.arch;
  if (architecture === "x86_64" || architecture === "amd64") return "linux-x64";
  if (architecture === "aarch64" || architecture === "arm64") return "linux-arm64";
  throw kernelError("unsupported", `${engine} architecture is unsupported`);
}

/** @internal Resolve a pinned Docker context without carrying unrelated host environment. */
export async function dockerContext(
  executable: string,
  environment: Readonly<Record<string, string>>,
): Promise<string> {
  if (environment.DOCKER_CONTEXT?.trim()) return environment.DOCKER_CONTEXT.trim();
  const result = await createNodeProcessRunner().run({
    command: executable,
    args: ["context", "show"],
    environment,
    timeoutMs: 10_000,
  });
  const context = result.stdout.trim();
  if (result.exitCode !== 0 || context === "" || /[\r\n\0]/u.test(context))
    throw kernelError("unavailable", "Docker context could not be resolved");
  return context;
}

/** @internal Select only engine client variables; none enter the guest process. */
export function engineEnvironment(
  engine: "docker" | "podman",
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const names =
    engine === "docker"
      ? ["HOME", "PATH", "DOCKER_CONFIG", "DOCKER_CONTEXT"]
      : ["HOME", "PATH", "XDG_RUNTIME_DIR"];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = source[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

/** @internal Exact preparer ownership adapter shared with deterministic connector tests. */
export function preparer(control: ContainerControl): ContainerVolumePreparer {
  return {
    async run(request) {
      const generation = request.labels["io.clarvis.generation"];
      const role = request.labels["io.clarvis.state.role"];
      if (generation === undefined || role === undefined)
        throw new Error("Container preparer identity is missing");
      const name = `clarvis-${role}-${generation}`;
      const completed = await runContainerPreparer({
        control,
        createArgs: request.createArgs,
        policy: { ...request.policy, name, labels: request.labels },
        signal: request.signal,
      });
      return {
        result: completed.result,
        evidence: {
          containerId: completed.containerId,
          labels: completed.labels,
          removed: true,
        },
      };
    },
  };
}

/** @internal Prepare the independently keyed mise cache used by one Container namespace. */
export async function prepareMiseVolume(options: {
  readonly control: ContainerControl;
  readonly namespace: string;
  readonly generation: string;
  readonly baseImageId: `sha256:${string}`;
  readonly engine: "docker" | "podman";
  readonly user: { readonly uid: number; readonly gid: number };
  readonly signal?: AbortSignal;
}): Promise<string> {
  const { control, namespace } = options;
  const digest = createHash("sha256")
    .update(JSON.stringify({ schema: 3, namespace, baseImageId: options.baseImageId }))
    .digest("hex");
  const name = `clarvis-mise-v3-${digest}`;
  const expected = {
    "io.clarvis.runtime.mise-cache": "true",
    "io.clarvis.runtime.mise-cache.schema": "3",
    "io.clarvis.runtime.mise-cache.identity": `sha256:${digest}`,
    "io.clarvis.runtime.mise-cache.base-image": options.baseImageId,
  };
  let inspected = await control.run(["volume", "inspect", name], options.signal);
  if (inspected.exitCode !== 0) {
    const created = await control.run(
      [
        "volume",
        "create",
        "--label",
        "io.clarvis.runtime.mise-cache=true",
        "--label",
        "io.clarvis.runtime.mise-cache.schema=3",
        "--label",
        `io.clarvis.runtime.mise-cache.identity=sha256:${digest}`,
        "--label",
        `io.clarvis.runtime.mise-cache.base-image=${options.baseImageId}`,
        name,
      ],
      options.signal,
    );
    if (created.exitCode !== 0)
      throw kernelError("unavailable", "Container mise cache could not be created");
    inspected = await control.run(["volume", "inspect", name], options.signal);
  }
  let root: unknown;
  try {
    const values = JSON.parse(inspected.stdout) as unknown;
    root = Array.isArray(values) ? values[0] : undefined;
  } catch {
    throw kernelError("conflict", "Container mise cache inspection is invalid");
  }
  const volume = root as { Name?: unknown; Labels?: unknown };
  const actual = volume.Labels as Record<string, unknown> | undefined;
  if (
    inspected.exitCode !== 0 ||
    volume.Name !== name ||
    actual === undefined ||
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value)
  )
    throw kernelError("conflict", "Container mise cache identity conflicts");
  const user = `${String(options.user.uid)}:${String(options.user.gid)}`;
  const labels = {
    "io.clarvis.generation": options.generation,
    "io.clarvis.state.role": "mise-preparer",
  };
  const mount =
    options.engine === "docker"
      ? ["--mount", `type=volume,source=${name},target=/cache,volume-nocopy`]
      : ["--volume", `${name}:/cache:nocopy`, "--read-only-tmpfs=false", "--userns=keep-id"];
  const script = `
set -eu
if [ -e /cache/ready ]; then
  test "$(cat /cache/ready)" = "3:$1"
  test "$(stat -c %u:%g:%a /cache/data)" = "$1:700"
else
  test -z "$(find /cache -mindepth 1 -maxdepth 1 -print -quit)"
  mkdir -m 700 /cache/data
  chown "$1" /cache/data
  printf '3:%s\\n' "$1" > /cache/ready.tmp
  chmod 600 /cache/ready.tmp
  mv /cache/ready.tmp /cache/ready
fi
`;
  const prepared = await preparer(control).run({
    labels,
    signal: options.signal,
    createArgs: [
      "create",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CHOWN",
      "--security-opt",
      "no-new-privileges=true",
      "--pids-limit",
      "16",
      "--memory",
      "67108864",
      ...Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      ...mount,
      "--entrypoint",
      "/bin/sh",
      options.baseImageId,
      "-euc",
      script,
      "clarvis-mise-preparer",
      user,
    ],
    policy: {
      user: "0:0",
      entrypoint: "/bin/sh",
      capabilityAdditions: ["CHOWN"],
      pidsLimit: 16,
      memoryBytes: 67_108_864,
      mounts: [{ type: "volume", source: name, target: "/cache", writable: true }],
    },
  });
  if (prepared.result.exitCode !== 0)
    throw kernelError("conflict", "Container mise cache ownership requires recovery");
  return name;
}

/** @internal Prove that the engine sees the same host workspace before persistent preparation. */
export async function verifySharedWorkspace(options: {
  readonly control: ContainerControl;
  readonly engine: "docker" | "podman";
  readonly baseImageId: `sha256:${string}`;
  readonly workspaceRoot: string;
  readonly user: { readonly uid: number; readonly gid: number };
  readonly signal?: AbortSignal;
}): Promise<void> {
  const id = randomUUID();
  const name = `.clarvis-container-preflight-${id}`;
  const path = join(options.workspaceRoot, name);
  const nonce = randomUUID();
  const file = await open(path, "wx", 0o444);
  try {
    await file.writeFile(`${nonce}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    const user = `${String(options.user.uid)}:${String(options.user.gid)}`;
    const sourceValue = options.workspaceRoot.replaceAll('"', '""');
    const source = /[",\r\n]/u.test(options.workspaceRoot)
      ? `"source=${sourceValue}"`
      : `source=${sourceValue}`;
    const target = "/workspace";
    const args = [
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--pids-limit",
      "8",
      "--memory",
      "33554432",
      "--user",
      user,
      "--mount",
      `type=bind,${source},target=${target},readonly${options.engine === "podman" ? ",relabel=shared" : ""}`,
      ...(options.engine === "podman" ? ["--read-only-tmpfs=false", "--userns=keep-id"] : []),
      "--entrypoint",
      "/bin/cat",
      options.baseImageId,
      `${target}/${name}`,
    ];
    const result = await options.control.run(args, options.signal, {
      timeoutMs: 30_000,
      maxOutputBytes: 4096,
    });
    if (result.exitCode !== 0 || result.stdout !== `${nonce}\n`)
      throw kernelError(
        "unsupported",
        "Container engine cannot access the selected local workspace with the admitted identity",
      );
  } finally {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

/** Resolve host configuration and start one complete local Docker/Podman Kernel. */
export async function connectLocalContainerKernel(
  options: ConnectLocalContainerKernelOptions,
): Promise<LaunchedContainerKernel> {
  const runtime = runtimeSettingsSchema.parse(options.runtime);
  if (runtime.backend === "native" || runtime.network === "internet")
    throw kernelError(
      "unsupported",
      "Container requires Docker/Podman with none or outbound network",
    );
  const engine = runtime.backend;
  const environment = engineEnvironment(engine, options.environment ?? process.env);
  const executable = runtime.executable ?? Bun.which(engine);
  if (executable === null || executable === undefined)
    throw kernelError("unavailable", `${engine} is not installed`);
  const connection =
    runtime.connection ??
    (engine === "docker" ? await dockerContext(executable, environment) : "local");
  const control =
    engine === "docker"
      ? createNodeDockerControl({ executable, context: connection, environment })
      : createNodePodmanControl({ executable, connection, environment });
  return connectLocalContainerKernelUsingControl(options, runtime, control);
}

/** @internal Deterministic engine-control seam for the connector orchestration contract. */
export async function connectLocalContainerKernelUsingControl(
  options: ConnectLocalContainerKernelOptions,
  runtime: Exclude<ReturnType<typeof runtimeSettingsSchema.parse>, { backend: "native" }>,
  control: ContainerControl,
  ports: LocalContainerConnectorPorts = {},
): Promise<LaunchedContainerKernel> {
  const engine = runtime.backend;
  if (runtime.network === "internet")
    throw kernelError("unsupported", "Container internet network mode is unavailable");
  const progress = (phase: ContainerConnectionPhase): void => options.onProgress?.(phase);
  const basePreparationSignal =
    options.signal === undefined
      ? AbortSignal.timeout(10 * 60_000)
      : AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60_000)]);
  progress("inspecting_engine");
  const target = await engineTarget(control, engine, basePreparationSignal);
  progress("resolving_runtime");
  const release =
    options.release ?? (await options.resolveRelease?.(target, basePreparationSignal));
  if (release === undefined)
    throw kernelError("invalid_request", "Container release selection is required");
  if (release.artifact.selection.target !== target)
    throw kernelError("unsupported", "Container artifact does not match the engine architecture");
  let baseImageId = (await resolveContainerImageDigest({
    configured: runtime.image_digest,
    control,
    resolveImage: async () => release.base,
    engine: engine === "docker" ? "Docker" : "Podman",
    signal: basePreparationSignal,
  })) as `sha256:${string}`;
  if (runtime.backend === "docker" && runtime.recipe !== undefined) {
    const recipeSignal =
      options.signal === undefined
        ? AbortSignal.timeout(30 * 60_000)
        : AbortSignal.any([options.signal, AbortSignal.timeout(30 * 60_000)]);
    baseImageId = (await resolveDockerRuntimeRecipe({
      baseImageDigest: baseImageId,
      recipe: runtime.recipe,
      control,
      roots: { env: { CLARVIS_HOME: options.globalDir } },
      signal: recipeSignal,
    })) as `sha256:${string}`;
  }
  const preparationSignal =
    options.signal === undefined
      ? AbortSignal.timeout(10 * 60_000)
      : AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60_000)]);
  const env = envSchema.parse({
    ...(options.environment ?? process.env),
    CLARVIS_OWNER: options.owner,
  });
  progress("inspecting_workspace");
  const git = await (ports.discoverWorkspace ?? discoverGitWorkspace)(options.workspaceRoot);
  const identity = await (ports.resolveVolumeIdentity ?? resolveContainerVolumeIdentity)({
    workspaceRoot: git.worktreeRoot,
    globalDir: options.globalDir,
    projectId: git.project.id,
  });
  const generation = randomUUID();
  const launchPaths = containerLaunchPaths(identity.namespace, identity.globalRoot);
  const createBackend =
    ports.createBackend ??
    ((
      selectedEngine: "docker" | "podman",
      selectedControl: ContainerControl,
      signal?: AbortSignal,
    ) =>
      selectedEngine === "docker"
        ? createDockerKernelBackend({ control: selectedControl, signal })
        : createPodmanKernelBackend({ control: selectedControl, signal }));
  const backend = createBackend(engine, control, preparationSignal);
  const acquireLease = ports.acquireLease ?? acquireLocalLease;
  let lease = await acquireLease(launchPaths.leaseFile, {
    staleMs: 1_000,
    waitMs: 1_000,
    heartbeatMs: 5_000,
    signal: preparationSignal,
  });
  if (lease === null && options.ownershipConflict === "terminate") {
    const previous = await readFile(launchPaths.registryFile, "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      },
    );
    let registry: unknown;
    try {
      registry = previous === undefined ? undefined : (JSON.parse(previous) as unknown);
    } catch {
      throw kernelError("conflict", "Container launch registry requires recovery");
    }
    const value = registry as Record<string, unknown> | undefined;
    if (
      value?.schema !== 1 ||
      value.engine !== engine ||
      typeof value.containerId !== "string" ||
      typeof value.generation !== "string"
    )
      throw kernelError("conflict", "Container launch registry identity conflicts");
    await backend.terminatePrevious({
      id: value.containerId,
      generation: value.generation,
      namespace: identity.namespace,
    });
    lease = await acquireLease(launchPaths.leaseFile, {
      staleMs: 1_000,
      waitMs: 30_000,
      heartbeatMs: 5_000,
      signal: preparationSignal,
    });
  }
  if (lease === null)
    throw kernelError("conflict", "Another Container Kernel owns this workspace namespace", {
      kind: "container_kernel_owned",
      engine,
    });
  let transferredLease: LocalLease | undefined;
  let mounts: Awaited<ReturnType<typeof prepareRuntimeMounts>> | undefined;
  let operator: ReturnType<typeof createOperatorServices> | undefined;
  try {
    progress("preparing_workspace");
    mounts = await (ports.prepareMounts ?? prepareRuntimeMounts)({
      workspaceRoot: identity.workspaceRoot,
      workspace: git.workspace,
      gitMetadataMounts: runtimeGitMetadataMounts(git),
    });
    operator = (ports.createOperator ?? createOperatorServices)({
      workspaceRoot: options.workspaceRoot,
      globalDir: options.globalDir,
      logger: options.logger,
    });
    const user =
      process.platform === "linux"
        ? { uid: userInfo().uid, gid: userInfo().gid }
        : { uid: 1000, gid: 1000 };
    await (ports.verifyWorkspace ?? verifySharedWorkspace)({
      control,
      engine,
      baseImageId,
      workspaceRoot: identity.workspaceRoot,
      user,
      signal: preparationSignal,
    });
    progress("preparing_artifact");
    const artifact = await (ports.cacheArtifact ?? cacheRuntimeArtifact)({
      cacheRoot: join(globalPaths(options.globalDir).cache, "runtime-artifacts"),
      source: release.artifact.source,
      selection: release.artifact.selection,
      signal: preparationSignal,
    });
    progress("preparing_state");
    const data = await (ports.prepareVolumes ?? prepareContainerVolumes)({
      control,
      preparer: preparer(control),
      namespace: identity.namespace,
      generation,
      baseImageId,
      user,
      engine,
      signal: preparationSignal,
    });
    const domainDataMounts = await (ports.prepareDomainMounts ?? prepareContainerDomainMounts)({
      workspaceRoot: identity.workspaceRoot,
      globalDir: identity.globalRoot,
      owner: options.owner,
      projectId: git.project.id,
      workspaceId: git.workspace.id,
    });
    await (ports.migrateDomainState ?? migrateContainerDomainState)({
      preparer: preparer(control),
      volumes: data,
      mounts: domainDataMounts,
      namespace: identity.namespace,
      generation,
      baseImageId,
      owner: options.owner,
      projectId: git.project.id,
      workspaceId: git.workspace.id,
      user,
      engine,
      signal: preparationSignal,
    });
    const artifactVolume = await (ports.prepareArtifactVolume ?? prepareRuntimeArtifactVolume)({
      control,
      engine,
      baseImageId,
      artifact,
      digest: release.artifact.selection.digest,
      size: release.artifact.selection.size,
      generation,
      signal: preparationSignal,
    });
    const configuration = await (ports.projectConfiguration ?? projectContainerHostConfiguration)({
      store: operator.configStore,
      models: operator.models,
      env,
      workspaceRoot: identity.workspaceRoot,
      globalDir: identity.globalRoot,
    });
    const limits: RuntimeLimits = {
      cpuCount: runtime.limits.cpu_count,
      memoryBytes: runtime.limits.memory_bytes,
      processCount: runtime.limits.process_count,
      outputBytes: runtime.limits.output_bytes,
      storageBytes: runtime.limits.storage_bytes,
    };
    const launch = {
      generation,
      namespace: identity.namespace,
      workspaceRoot: identity.workspaceRoot,
      controlRootMasks: mounts.controlRootMasks,
      gitMetadataMounts: mounts.gitMetadataMounts,
      domainDataMounts,
      baseImageId,
      baseAbi: "clarvis-linux-glibc-v1",
      artifact: {
        volume: artifactVolume.name,
        digest: release.artifact.selection.digest,
        target: release.artifact.selection.target,
      },
      data: { contentVolume: data.content.name, stateVolume: data.state.name },
      miseVolume: await (ports.prepareMise ?? prepareMiseVolume)({
        control,
        namespace: identity.namespace,
        generation,
        baseImageId,
        engine,
        user,
        signal: preparationSignal,
      }),
      network: runtime.network,
      limits,
      user,
    } as const;
    progress("starting_kernel");
    return await (ports.launch ?? launchContainerKernel)({
      backend,
      engine,
      launch,
      artifact,
      configuration,
      project: git.project,
      workspace: { ...git.workspace, path: "/workspace" },
      owner: options.owner,
      globalDir: identity.globalRoot,
      env,
      protectedMounts: mounts,
      logger: options.logger,
      operator,
      lease: (transferredLease = lease),
      signal: preparationSignal,
    });
  } catch (error) {
    if (transferredLease === undefined) {
      await lease.release().catch(() => undefined);
      await operator?.close().catch(() => undefined);
      await mounts?.cleanup().catch(() => undefined);
    }
    throw error;
  }
}
