import { posix, relative, sep } from "node:path";
import type { MiseCacheIdentity } from "./container-mise-cache.ts";
import type { RuntimeLaunchSpec } from "./types.ts";

type RecordValue = Record<string, unknown>;

/** Engine-neutral projection of effective container policy; absent fields fail admission. */
export interface ContainerPolicy {
  generation: unknown;
  network: unknown;
  privileged: unknown;
  readOnlyRoot: unknown;
  memoryBytes: unknown;
  processCount: unknown;
  nanoCpus: unknown;
  securityOptions: unknown;
  tmpfs: unknown;
  mounts: readonly RecordValue[];
  identityAccepted: boolean;
  capabilitiesCleared: boolean;
  cacheLayoutAccepted: boolean;
}

function record(value: unknown): RecordValue | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

/** Decode common OCI inspection fields while retaining engine-specific facts for its adapter. */
export function readContainerInspection(value: unknown):
  | {
      root: RecordValue;
      host: RecordValue;
      config: RecordValue;
      policy: Omit<
        ContainerPolicy,
        "identityAccepted" | "capabilitiesCleared" | "cacheLayoutAccepted"
      >;
    }
  | undefined {
  const root = record(Array.isArray(value) && value.length === 1 ? value[0] : value);
  const host = record(root?.HostConfig);
  const config = record(root?.Config);
  if (
    root === undefined ||
    host === undefined ||
    config === undefined ||
    !Array.isArray(root.Mounts)
  )
    return undefined;
  const mounts = root.Mounts.map(record);
  if (mounts.some((mount) => mount === undefined)) return undefined;
  return {
    root,
    host,
    config,
    policy: {
      generation: record(config.Labels)?.["io.clarvis.generation"],
      network: host.NetworkMode,
      privileged: host.Privileged,
      readOnlyRoot: host.ReadonlyRootfs,
      memoryBytes: host.Memory,
      processCount: host.PidsLimit,
      nanoCpus: host.NanoCpus,
      securityOptions: host.SecurityOpt,
      tmpfs: host.Tmpfs,
      mounts: mounts as RecordValue[],
    },
  };
}

/** The selected workspace and read-only overlays have the same targets on every engine. */
export function guestWorkspacePath(spec: RuntimeLaunchSpec, hostPath: string): string {
  return posix.join("/workspace", relative(spec.workspaceRoot, hostPath).split(sep).join("/"));
}

/** Encode one `--mount` key/value as a field for the engines' outer CSV parser. */
export function containerMountField(name: string, value: string): string {
  const field = `${name}=${value}`;
  return /[",\r\n]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

/** Empty capability arrays and the engine's explicit null representation carry no privilege. */
export function noContainerCapabilities(value: unknown): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

/** Apply the shared launch invariants to an engine's normalized effective inspection. */
export function validContainerPolicy(
  policy: ContainerPolicy,
  spec: RuntimeLaunchSpec,
  cache: MiseCacheIdentity,
): boolean {
  const security = policy.securityOptions;
  const privilegeOptions = Array.isArray(security)
    ? security.filter(
        (option) => typeof option === "string" && option.startsWith("no-new-privileges"),
      )
    : [];
  const tmpfs = record(policy.tmpfs);
  const scratch = typeof tmpfs?.["/tmp"] === "string" ? tmpfs["/tmp"].split(",") : [];
  const expectedBinds = [
    { source: spec.workspaceRoot, destination: "/workspace", writable: true },
    ...spec.readOnlyWorkspacePaths.map((path) => ({
      source: path,
      destination: guestWorkspacePath(spec, path),
      writable: false,
    })),
    ...(spec.gitCommonDir === undefined
      ? []
      : [{ source: spec.gitCommonDir, destination: spec.gitCommonDir, writable: true }]),
  ];
  const mise = policy.mounts.filter((mount) => mount.Destination === "/mise");
  return (
    policy.identityAccepted &&
    policy.capabilitiesCleared &&
    policy.cacheLayoutAccepted &&
    policy.privileged === false &&
    policy.readOnlyRoot === true &&
    policy.generation === spec.generation &&
    policy.network === (spec.network === "none" ? "none" : "bridge") &&
    policy.memoryBytes === spec.limits.memoryBytes &&
    policy.processCount === spec.limits.processCount &&
    policy.nanoCpus === spec.limits.cpuCount * 1_000_000_000 &&
    Array.isArray(security) &&
    security.every((option) => typeof option === "string") &&
    privilegeOptions.length === 1 &&
    ["no-new-privileges", "no-new-privileges=true"].includes(privilegeOptions[0] as string) &&
    Object.keys(tmpfs ?? {}).length === 1 &&
    ["rw", "nosuid", "nodev", "noexec", `size=${spec.limits.storageBytes}`].every((option) =>
      scratch.includes(option),
    ) &&
    scratch.filter((option) => option.startsWith("size=")).length === 1 &&
    !scratch.some((option) => ["ro", "suid", "dev", "exec"].includes(option)) &&
    policy.mounts.length === expectedBinds.length + 1 &&
    expectedBinds.every((expected) => {
      const matches = policy.mounts.filter((mount) => mount.Destination === expected.destination);
      return (
        matches.length === 1 &&
        matches[0]?.Type === "bind" &&
        matches[0]?.Source === expected.source &&
        matches[0]?.RW === expected.writable
      );
    }) &&
    mise.length === 1 &&
    mise[0]?.Type === "volume" &&
    mise[0]?.Name === cache.name &&
    mise[0]?.RW === true
  );
}
