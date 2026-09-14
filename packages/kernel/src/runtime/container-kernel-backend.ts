import { lstat } from "node:fs/promises";
import { sanitizeErrorMessage } from "@clarvis/capability";
import type {
  ContainerControl,
  ContainerKernelBackend,
  ContainerKernelLaunchSpec,
  ContainerProcessLifecycle,
  RuntimeAvailability,
} from "./types.ts";
import { RuntimeLaunchError } from "./types.ts";
import { CONTAINER_BASE_ABI } from "../hosting/container-contract.ts";
import { inspectContainerBaseImage } from "./runtime-image.ts";
import {
  containerRecord,
  exactContainerId,
  hasExactEffectiveCapabilities,
  hasExactTmpfsOptions,
  hasNoNewPrivileges,
} from "./container-inspection.ts";

const idPattern = /^(?:sha256:)?([a-f0-9]{64})$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const volumePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/u;

const record = containerRecord;

function json(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new RuntimeLaunchError("operational_failure", `${label} returned invalid JSON`, {
      cause,
    });
  }
}

function exactId(value: unknown): string | undefined {
  return exactContainerId(value);
}

function engineName(generation: string): string {
  return `clarvis-kernel-${generation}`;
}

function containerMountField(name: string, value: string): string {
  const field = `${name}=${value}`;
  return /[",\r\n]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

function mount(type: "bind" | "volume", source: string, target: string, options = ""): string {
  return `${type === "bind" ? "type=bind" : "type=volume"},${containerMountField("source", source)},${containerMountField("target", target)}${options}`;
}

function assertLaunchSpec(spec: ContainerKernelLaunchSpec): void {
  if (
    !uuidPattern.test(spec.generation) ||
    !/^[a-f0-9]{64}$/u.test(spec.namespace) ||
    !/^sha256:[a-f0-9]{64}$/u.test(spec.baseImageId) ||
    spec.baseAbi !== CONTAINER_BASE_ABI ||
    !/^sha256:[a-f0-9]{64}$/u.test(spec.artifact.digest) ||
    ![spec.artifact.volume, spec.data.contentVolume, spec.data.stateVolume, spec.miseVolume].every(
      (value) => volumePattern.test(value),
    ) ||
    !Number.isSafeInteger(spec.user.uid) ||
    !Number.isSafeInteger(spec.user.gid) ||
    spec.user.uid < 0 ||
    spec.user.gid < 0 ||
    Object.values(spec.limits).some((value) => !Number.isSafeInteger(value) || value <= 0)
  )
    throw new RuntimeLaunchError("invalid_launch_spec", "Container Kernel launch spec is invalid");
}

async function assertMountSources(spec: ContainerKernelLaunchSpec): Promise<void> {
  const workspace = await lstat(spec.workspaceRoot);
  if (!workspace.isDirectory() || workspace.isSymbolicLink())
    throw new RuntimeLaunchError(
      "unsupported_policy",
      "Container workspace is not a real directory",
    );
  for (const protectedMount of [...spec.controlRootMasks, ...spec.gitMetadataMounts]) {
    const source = await lstat(protectedMount.source);
    if (
      source.isSymbolicLink() ||
      (protectedMount.type === "directory" ? !source.isDirectory() : !source.isFile())
    )
      throw new RuntimeLaunchError("unsupported_policy", "Container protected mount is invalid");
  }
}

function createArgs(engine: "docker" | "podman", spec: ContainerKernelLaunchSpec): string[] {
  const user = `${String(spec.user.uid)}:${String(spec.user.gid)}`;
  const volumeOptions = engine === "docker" ? ",volume-nocopy" : "";
  const volumeMount = (
    source: string,
    target: string,
    readonly: boolean,
    subpath?: string,
  ): string[] => [
    "--mount",
    mount(
      "volume",
      source,
      target,
      `${volumeOptions}${subpath === undefined ? "" : `,${engine === "docker" ? "volume-subpath" : "subpath"}=${subpath}`}${readonly ? ",readonly" : ""}`,
    ),
  ];
  const bindMount = (source: string, target: string, readonly = false): string[] => [
    "--mount",
    mount(
      "bind",
      source,
      target,
      `${readonly ? ",readonly" : ""}${engine === "podman" ? ",relabel=shared" : ""}`,
    ),
  ];
  return [
    "create",
    "--name",
    engineName(spec.generation),
    "--label",
    "io.clarvis.managed=true",
    "--label",
    "io.clarvis.role=kernel",
    "--label",
    `io.clarvis.generation=${spec.generation}`,
    "--label",
    `io.clarvis.state.namespace=${spec.namespace}`,
    "--interactive",
    "--user",
    user,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    String(spec.limits.processCount),
    "--memory",
    String(spec.limits.memoryBytes),
    "--cpus",
    String(spec.limits.cpuCount),
    "--network",
    spec.network === "none" ? "none" : "bridge",
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,noexec,size=${String(spec.limits.storageBytes)}`,
    ...bindMount(spec.workspaceRoot, "/workspace"),
    ...volumeMount(spec.data.contentVolume, "/workspace/.clarvis", false, "data"),
    ...volumeMount(spec.data.stateVolume, "/var/lib/clarvis", false, "data"),
    ...volumeMount(spec.artifact.volume, "/opt/clarvis", true, "payload"),
    ...volumeMount(spec.miseVolume, "/mise", false, "data"),
    ...[...spec.controlRootMasks, ...spec.gitMetadataMounts].flatMap((entry) =>
      bindMount(entry.source, entry.target, true),
    ),
    "--workdir",
    "/workspace",
    "--entrypoint",
    "/opt/clarvis/bin/clarvis-kernel",
    ...(engine === "podman" ? ["--unsetenv-all"] : []),
    "--env",
    "PATH=/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--env",
    "HOME=/var/lib/clarvis/home",
    "--env",
    "TMPDIR=/tmp",
    "--env",
    "LANG=C.UTF-8",
    "--env",
    "LC_ALL=C.UTF-8",
    "--env",
    "TZ=UTC",
    "--env",
    "MISE_QUIET=1",
    "--env",
    "MISE_DATA_DIR=/mise",
    "--env",
    "MISE_CACHE_DIR=/mise/cache",
    "--env",
    "MISE_CONFIG_DIR=/mise/config",
    "--env",
    "MISE_STATE_DIR=/mise/state",
    ...(engine === "podman" ? ["--read-only-tmpfs=false"] : []),
    ...(engine === "podman" ? ["--userns=keep-id"] : []),
    spec.baseImageId,
  ];
}

function validTmpfs(value: unknown, expectedSize: number, engine: "docker" | "podman"): boolean {
  return hasExactTmpfsOptions(value, [
    "rw",
    "nosuid",
    "nodev",
    "noexec",
    `size=${String(expectedSize)}`,
    ...(engine === "podman" ? ["rprivate", "tmpcopyup"] : []),
  ]);
}

function validContainerInspect(
  value: unknown,
  spec: ContainerKernelLaunchSpec,
  engine: "docker" | "podman",
): string | undefined {
  const root = record(Array.isArray(value) && value.length === 1 ? value[0] : undefined);
  const host = record(root?.HostConfig);
  const config = record(root?.Config);
  const labels = record(config?.Labels);
  const mounts = Array.isArray(root?.Mounts) ? root.Mounts.map(record) : [];
  const environment = Array.isArray(config?.Env) ? config.Env : undefined;
  const id = exactId(root?.Id);
  if (
    root === undefined ||
    id === undefined ||
    host === undefined ||
    config === undefined ||
    labels?.["io.clarvis.generation"] !== spec.generation ||
    labels?.["io.clarvis.state.namespace"] !== spec.namespace ||
    labels?.["io.clarvis.managed"] !== "true" ||
    labels?.["io.clarvis.role"] !== "kernel" ||
    host.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    host.PidsLimit !== spec.limits.processCount ||
    host.Memory !== spec.limits.memoryBytes ||
    host.NanoCpus !== spec.limits.cpuCount * 1_000_000_000 ||
    host.NetworkMode !== (spec.network === "none" ? "none" : "bridge") ||
    config.User !== `${String(spec.user.uid)}:${String(spec.user.gid)}` ||
    config.WorkingDir !== "/workspace" ||
    !Array.isArray(config.Entrypoint) ||
    config.Entrypoint.length !== 1 ||
    config.Entrypoint[0] !== "/opt/clarvis/bin/clarvis-kernel" ||
    environment === undefined ||
    environment.length !== 11 ||
    ![
      "PATH=/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "HOME=/var/lib/clarvis/home",
      "TMPDIR=/tmp",
      "LANG=C.UTF-8",
      "LC_ALL=C.UTF-8",
      "TZ=UTC",
      "MISE_QUIET=1",
      "MISE_DATA_DIR=/mise",
      "MISE_CACHE_DIR=/mise/cache",
      "MISE_CONFIG_DIR=/mise/config",
      "MISE_STATE_DIR=/mise/state",
    ].every((entry) => environment.includes(entry)) ||
    !hasExactEffectiveCapabilities(root, host, []) ||
    !hasNoNewPrivileges(host.SecurityOpt) ||
    !validTmpfs(record(host.Tmpfs)?.["/tmp"], spec.limits.storageBytes, engine) ||
    mounts.some((entry) => entry === undefined)
  )
    return undefined;
  const expected = [
    ["/workspace", "bind", spec.workspaceRoot, true],
    ["/workspace/.clarvis", "volume", spec.data.contentVolume, true],
    ["/var/lib/clarvis", "volume", spec.data.stateVolume, true],
    ["/opt/clarvis", "volume", spec.artifact.volume, false],
    ["/mise", "volume", spec.miseVolume, true],
    ...[...spec.controlRootMasks, ...spec.gitMetadataMounts].map((entry) => [
      entry.target,
      "bind",
      entry.source,
      false,
    ]),
  ] as const;
  if (
    mounts.length !== expected.length ||
    expected.some(([target, type, source, writable]) => {
      const candidates = mounts.filter((entry) => entry?.Destination === target);
      const candidate = candidates[0];
      return (
        candidates.length !== 1 ||
        candidate?.Type !== type ||
        (type === "bind" ? candidate.Source : candidate.Name) !== source ||
        candidate.RW !== writable
      );
    })
  )
    return undefined;
  return id;
}

/** Shared complete-Kernel adapter used by the Docker and Podman frontends. */
export function createContainerKernelBackend(options: {
  readonly engine: "docker" | "podman";
  readonly control: ContainerControl;
  readonly hostPlatform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
}): ContainerKernelBackend {
  let inspected = false;
  const proveAbsent = async (filter: string, signal?: AbortSignal): Promise<void> => {
    const listed = await options.control.run(
      ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", filter],
      signal,
    );
    if (listed.exitCode !== 0 || listed.stdout.trim() !== "")
      throw new RuntimeLaunchError(
        "operational_failure",
        "Container absence could not be confirmed",
      );
  };
  const inspectOwned = async (
    reference: string,
    identity: { generation: string; namespace: string; role: string },
    signal?: AbortSignal,
  ): Promise<{ id: string; root: Record<string, unknown> } | undefined> => {
    const result = await options.control.run(["container", "inspect", reference], signal);
    if (result.exitCode !== 0) {
      await proveAbsent(
        idPattern.test(reference) ? `id=${exactId(reference)!}` : `name=^/${reference}$`,
        signal,
      );
      return undefined;
    }
    const parsed = json(result.stdout, "container ownership inspect");
    const root = record(Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined);
    const id = exactId(root?.Id);
    const labels = record(record(root?.Config)?.Labels);
    if (
      root === undefined ||
      id === undefined ||
      labels?.["io.clarvis.managed"] !== "true" ||
      labels?.["io.clarvis.role"] !== identity.role ||
      labels?.["io.clarvis.generation"] !== identity.generation ||
      labels?.["io.clarvis.state.namespace"] !== identity.namespace
    )
      throw new RuntimeLaunchError("operational_failure", "Container ownership is unconfirmed");
    return { id, root };
  };
  return {
    async inspect(): Promise<RuntimeAvailability> {
      try {
        const result = await options.control.run(
          options.engine === "docker"
            ? ["info", "--format", "{{json .}}"]
            : ["info", "--format", "json"],
          options.signal,
        );
        if (result.exitCode !== 0)
          return {
            available: false,
            reason: "engine_stopped",
            message: `${options.engine} is not ready`,
          };
        const root = record(json(result.stdout, `${options.engine} info`));
        const version =
          options.engine === "docker" ? root?.ServerVersion : record(root?.version)?.Version;
        const os = options.engine === "docker" ? root?.OSType : record(root?.host)?.os;
        if (typeof version !== "string" || (os !== "linux" && os !== undefined))
          return {
            available: false,
            reason: "unsupported_policy",
            message: `the selected ${options.engine} connection is not a Linux engine`,
          };
        inspected = true;
        return { available: true, engineVersion: version, rootless: options.engine === "podman" };
      } catch {
        options.signal?.throwIfAborted();
        return {
          available: false,
          reason: "engine_missing",
          message: `${options.engine} is unavailable`,
        };
      }
    },
    async reconcilePrevious(input): Promise<void> {
      if (!idPattern.test(input.id) || !uuidPattern.test(input.generation))
        throw new RuntimeLaunchError(
          "invalid_launch_spec",
          "Container registry identity is invalid",
        );
      const owned = await inspectOwned(
        input.id,
        { generation: input.generation, namespace: input.namespace, role: "kernel" },
        options.signal,
      );
      if (owned === undefined) return;
      if (owned.id !== exactId(input.id))
        throw new RuntimeLaunchError(
          "operational_failure",
          "Previous Container ownership is unconfirmed",
        );
      const state = record(owned.root.State);
      if (state?.Running === true)
        throw new RuntimeLaunchError(
          "operational_failure",
          "Previous Container Kernel is still running",
        );
      const removed = await options.control.run(["rm", input.id], options.signal);
      if (removed.exitCode !== 0)
        throw new RuntimeLaunchError(
          "operational_failure",
          "Previous Container cleanup is unconfirmed",
        );
      if (
        (await inspectOwned(
          input.id,
          { generation: input.generation, namespace: input.namespace, role: "kernel" },
          options.signal,
        )) !== undefined
      )
        throw new RuntimeLaunchError(
          "operational_failure",
          "Previous Container removal is unconfirmed",
        );
    },
    async startKernel(spec): Promise<ContainerProcessLifecycle> {
      if (!inspected)
        throw new RuntimeLaunchError(
          "operational_failure",
          `${options.engine} must be inspected before launch`,
        );
      assertLaunchSpec(spec);
      await assertMountSources(spec);
      const admittedBase = await inspectContainerBaseImage({
        reference: spec.baseImageId,
        control: options.control,
        engine: options.engine === "docker" ? "Docker" : "Podman",
        signal: options.signal,
      });
      if (admittedBase !== spec.baseImageId)
        throw new RuntimeLaunchError(
          "handshake_mismatch",
          "Container base identity or ABI did not match admission",
        );
      const name = engineName(spec.generation);
      let id: string | undefined;
      try {
        const created = await options.control.run(createArgs(options.engine, spec), options.signal);
        if (created.exitCode !== 0) {
          const detail = sanitizeErrorMessage(created.stderr)
            .replace(/[\r\n\t]+/gu, " ")
            .replace(/\s+/gu, " ")
            .trim()
            .slice(0, 1024);
          throw new RuntimeLaunchError(
            "operational_failure",
            `${options.engine} create failed${detail === "" ? "" : `: ${detail}`}`,
          );
        }
        const owned = await inspectOwned(
          name,
          { generation: spec.generation, namespace: spec.namespace, role: "kernel" },
          options.signal,
        );
        if (owned === undefined)
          throw new RuntimeLaunchError("operational_failure", `${options.engine} inspect failed`);
        id = owned.id;
        const inspectionValue = [owned.root];
        if (validContainerInspect(inspectionValue, spec, options.engine) !== id)
          throw new RuntimeLaunchError(
            "unsupported_policy",
            "Container effective policy did not match admission",
          );
        const process = options.control.attach(["start", "--attach", "--interactive", id]);
        let removed = false;
        return {
          id,
          process,
          async stop(graceSeconds) {
            const seconds = Math.max(1, Math.min(30, graceSeconds));
            const stopped = await options.control.run(["stop", "--time", String(seconds), id!]);
            if (stopped.exitCode !== 0)
              throw new RuntimeLaunchError("operational_failure", `${options.engine} stop failed`);
          },
          async kill() {
            const killed = await options.control.run(["kill", id!]);
            if (killed.exitCode !== 0)
              throw new RuntimeLaunchError("operational_failure", `${options.engine} kill failed`);
          },
          async remove() {
            if (removed) return;
            const result = await options.control.run(["rm", "--force", id!]);
            if (result.exitCode !== 0)
              throw new RuntimeLaunchError(
                "operational_failure",
                `${options.engine} remove failed`,
              );
            if (
              (await inspectOwned(
                id!,
                { generation: spec.generation, namespace: spec.namespace, role: "kernel" },
                AbortSignal.timeout(30_000),
              )) !== undefined
            )
              throw new RuntimeLaunchError(
                "operational_failure",
                `${options.engine} removal is unconfirmed`,
              );
            removed = true;
          },
        };
      } catch (error) {
        const cleanupSignal = AbortSignal.timeout(30_000);
        try {
          const cleanupId =
            id ??
            (
              await inspectOwned(
                name,
                { generation: spec.generation, namespace: spec.namespace, role: "kernel" },
                cleanupSignal,
              )
            )?.id;
          if (cleanupId !== undefined) {
            const removed = await options.control.run(["rm", "--force", cleanupId], cleanupSignal);
            if (removed.exitCode !== 0)
              throw new RuntimeLaunchError(
                "operational_failure",
                `${options.engine} cleanup failed`,
              );
            if (
              (await inspectOwned(
                cleanupId,
                { generation: spec.generation, namespace: spec.namespace, role: "kernel" },
                cleanupSignal,
              )) !== undefined
            )
              throw new RuntimeLaunchError(
                "operational_failure",
                `${options.engine} cleanup removal is unconfirmed`,
              );
          }
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "Container launch cleanup is unconfirmed",
            { cause: cleanupError },
          );
        }
        throw error;
      }
    },
  };
}
