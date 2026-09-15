import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  containerDataVolumeNames,
  containerGuestPaths,
  globalPaths,
  ownerSegment,
  workspaceScopeKey,
} from "@clarvis/paths";
import { kernelError } from "../core/errors.ts";
import type { DockerControl, DockerCommandResult } from "./docker-backend.ts";
import type { ContainerPreparerPolicy } from "./container-preparer.ts";
import { RuntimeLaunchError, type RuntimeDataMount } from "./types.ts";

/** Host-only identity. Engine, artifact and generation deliberately do not participate. */
export interface ContainerVolumeIdentity {
  readonly namespace: string;
  readonly globalRoot: string;
  readonly workspaceRoot: string;
  readonly projectId: string;
}

function outside(workspace: string, candidate: string): void {
  const inside = relative(workspace, candidate);
  if (inside === "" || (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)))
    throw kernelError("unauthorized", "Container operator state must be outside the workspace");
}

async function canonicalOptionalFile(path: string): Promise<string> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(await realpath(dirname(path)), path.slice(dirname(path).length + 1));
  }
  return realpath(path);
}

/** Resolve existing real host roots and the invoking account; never accepts an account override. */
export async function resolveContainerVolumeIdentity(options: {
  readonly workspaceRoot: string;
  readonly globalDir?: string;
  readonly projectId: string;
  readonly secretStorePath?: string;
}): Promise<ContainerVolumeIdentity> {
  if (options.projectId.length === 0 || options.projectId.length > 256)
    throw kernelError("invalid_request", "Container project identity is invalid");
  const workspaceRoot = await realpath(resolve(options.workspaceRoot));
  const paths = globalPaths(options.globalDir);
  const globalRoot = await realpath(resolve(paths.root));
  outside(workspaceRoot, globalRoot);
  outside(
    workspaceRoot,
    await canonicalOptionalFile(resolve(options.secretStorePath ?? paths.keysFile)),
  );
  outside(workspaceRoot, await canonicalOptionalFile(resolve(paths.subscriptionsFile)));
  const account = userInfo();
  const operatorId =
    account.uid >= 0 ? String(account.uid) : `${account.username}:${account.homedir}`;
  const namespace = createHash("sha256")
    .update(
      JSON.stringify({
        schema: 1,
        placement: "container",
        operatorId,
        globalRoot,
        projectId: options.projectId,
        workspaceRoot,
      }),
    )
    .digest("hex");
  return { namespace, globalRoot, projectId: options.projectId, workspaceRoot };
}

/** Caller supplies admitted Linux IDs (including a qualified Podman mapping). No root guest. */
export function containerVolumeUser(identity: {
  readonly uid: number;
  readonly gid: number;
}): string {
  if (
    ![identity.uid, identity.gid].every(
      (id) => Number.isSafeInteger(id) && id > 0 && id < 4294967295,
    )
  )
    throw new RuntimeLaunchError(
      "unsupported_policy",
      "Container data requires nonroot numeric UID/GID",
    );
  return `${identity.uid}:${identity.gid}`;
}

type Role = "content" | "state";
const roles = ["content", "state"] as const;
function labels(namespace: string, role: Role): Readonly<Record<string, string>> {
  return {
    "io.clarvis.managed": "true",
    "io.clarvis.state.schema": "1",
    "io.clarvis.state.namespace": namespace,
    "io.clarvis.state.role": role,
  };
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RuntimeLaunchError(
      "operational_failure",
      "Container volume inspection returned invalid JSON",
    );
  }
}
function operational(): RuntimeLaunchError {
  return new RuntimeLaunchError("operational_failure", "Container volume preparation failed");
}

/** Ownership evidence must come from exact container inspection, never a name-prefix search. */
export interface ContainerPreparerEvidence {
  readonly containerId: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly removed: true;
}
/**
 * Launcher lifecycle seam using the existing engine process runner. Implementations must inspect
 * effective policy before start, reconcile interrupted create, remove only the label-verified exact
 * ID, and throw on unconfirmed cleanup (including cancellation). No volume deletion is authorized.
 */
export interface ContainerVolumePreparer {
  run(request: {
    readonly createArgs: readonly string[];
    readonly labels: Readonly<Record<string, string>>;
    readonly policy: Omit<ContainerPreparerPolicy, "name" | "labels">;
    readonly signal?: AbortSignal;
  }): Promise<{
    readonly result: DockerCommandResult;
    readonly evidence: ContainerPreparerEvidence;
  }>;
}

const initializeScript = `
umask 077
check_dir() {
  test ! -L "$1" && test -d "$1" || exit 73
  test "$(stat -c %u:%g:%a "$1")" = "$2:700" || exit 73
}
check_ready() {
  test ! -L "$1/ready" && test -f "$1/ready" || exit 73
  test "$(stat -c %u:%g:%a "$1/ready")" = "0:0:600" || exit 73
  test "$(cat "$1/ready")" = "1:$2" || exit 73
  check_dir "$1/data" "$2"
}
for root in /content /state; do
  test ! -L "$root" && test -d "$root" || exit 73
  test "$(stat -c %u:%g:%a "$root")" = "0:0:755" || exit 73
done
if [ -e /content/ready ] && [ -e /state/ready ]; then
  check_ready /content "$1"
  check_ready /state "$1"
else
  for root in /content /state; do
    test -z "$(find "$root" -mindepth 1 -maxdepth 1 -print -quit)" || exit 73
  done
  mkdir -m 700 /content/data /state/data /state/data/home
  chown "$1" /state/data/home
  check_dir /state/data/home "$1"
  chown "$1" /content/data /state/data
  check_dir /content/data "$1"
  check_dir /state/data "$1"
  printf '1:%s\\n' "$1" > /content/ready.tmp
  printf '1:%s\\n' "$1" > /state/ready.tmp
  mv /content/ready.tmp /content/ready
  mv /state/ready.tmp /state/ready
fi
`;
const validateScript = `
for dir in /content/data /state/data /state/data/home; do
  test ! -L "$dir" && test -d "$dir" || exit 73
  test "$(stat -c %u:%g:%a "$dir")" = "$1:700" || exit 73
done
`;

/** Two retained volumes; launcher mounts only their private data subdirectories. */
export interface PreparedContainerVolumes {
  readonly namespace: string;
  readonly content: { readonly name: string; readonly subpath: "data"; readonly target: string };
  readonly state: { readonly name: string; readonly subpath: "data"; readonly target: string };
}

const migrateDomainScript = `
umask 077
marker=/legacy-state/data/.domain-state-host-v1
test ! -L "$marker" || exit 73
ensure_dir() {
  if test -e "$1"; then test ! -L "$1" && test -d "$1" || exit 73; else mkdir -m 700 "$1"; fi
}
ensure_dir /legacy-state/data/state
ensure_dir /legacy-state/data/state/workspaces
ensure_dir "/legacy-state/data/state/workspaces/$2"
ensure_dir "/legacy-state/data/state/workspaces/$2/plans"
ensure_dir "/legacy-state/data/state/workspaces/$2/memory"
ensure_dir "/legacy-state/data/state/workspaces/$2/trace-locks"
ensure_dir /legacy-state/data/state/traces
ensure_dir "/legacy-state/data/state/traces/$1"
ensure_dir /legacy-state/data/state/sessions
ensure_dir "/legacy-state/data/state/sessions/$1"
ensure_dir /legacy-state/data/state/workflows
ensure_dir "/legacy-state/data/state/workflows/$1"
test ! -e "$marker" || exit 0
validate_tree() {
  root="$1"
  test ! -L "$root" && test -d "$root" || exit 73
  test -z "$(find "$root" -xdev ! -type d ! -type f -print -quit)" || exit 73
  test -z "$(find "$root" -xdev -type f -links +1 -print -quit)" || exit 73
}
for root in /canonical/0 /canonical/1 /canonical/2 /canonical/3 /canonical/4 /canonical/5 /canonical/6 /canonical/7; do
  validate_tree "$root"
done
printf '1\n' > "$marker.tmp"
mv "$marker.tmp" "$marker"
`;

function mountField(name: string, value: string): string {
  const field = `${name}=${value}`;
  return /[",\r\n]/u.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
}

function preparerMount(
  type: "bind" | "volume",
  source: string,
  target: string,
  engine: "docker" | "podman",
  readonly: boolean,
): string {
  return `type=${type},${mountField("source", source)},${mountField("target", target)}${readonly ? ",readonly" : ""}${type === "bind" && engine === "podman" ? ",relabel=shared" : ""}`;
}

/** Retire legacy private-volume domain data once; canonical host mounts always win. */
export async function migrateContainerDomainState(options: {
  readonly preparer: ContainerVolumePreparer;
  readonly volumes: PreparedContainerVolumes;
  readonly mounts: readonly RuntimeDataMount[];
  readonly namespace: string;
  readonly generation: string;
  readonly baseImageId: string;
  readonly owner: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly user: { readonly uid: number; readonly gid: number };
  readonly engine: "docker" | "podman";
  readonly signal?: AbortSignal;
}): Promise<void> {
  if (options.mounts.length !== 8)
    throw new RuntimeLaunchError("invalid_launch_spec", "Container domain mount set is incomplete");
  const stateOwner = ownerSegment(
    workspaceScopeKey(options.owner, options.projectId, options.workspaceId),
  );
  const workspaceStateSegment = basename(containerGuestPaths.workspaceStateRoot);
  const user = containerVolumeUser(options.user);
  const ownership = {
    "io.clarvis.managed": "true",
    "io.clarvis.state.namespace": options.namespace,
    "io.clarvis.generation": options.generation,
    "io.clarvis.state.role": "preparer-domain-migration",
  };
  const mounts = [
    {
      type: "volume" as const,
      source: options.volumes.state.name,
      target: "/legacy-state",
      writable: true,
    },
    ...options.mounts.map((entry, index) => ({
      type: "bind" as const,
      source: entry.source,
      target: `/canonical/${String(index)}`,
      writable: true,
    })),
  ];
  const createArgs = [
    "create",
    "--network",
    "none",
    "--read-only",
    "--user",
    user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--pids-limit",
    "32",
    "--memory",
    "134217728",
    ...Object.entries(ownership).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
    ...mounts.flatMap((entry) => [
      "--mount",
      preparerMount(entry.type, entry.source, entry.target, options.engine, !entry.writable),
    ]),
    ...(options.engine === "podman" ? ["--read-only-tmpfs=false", "--userns=keep-id"] : []),
    "--entrypoint",
    "/bin/bash",
    options.baseImageId,
    "-euc",
    migrateDomainScript,
    "clarvis-domain-migration",
    stateOwner,
    workspaceStateSegment,
  ];
  const { result, evidence } = await options.preparer.run({
    createArgs,
    labels: ownership,
    policy: {
      user,
      entrypoint: "/bin/bash",
      capabilityAdditions: [],
      pidsLimit: 32,
      memoryBytes: 134_217_728,
      mounts,
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (evidence.removed !== true || result.exitCode !== 0) {
    if (result.exitCode === 73)
      throw kernelError("conflict", "Container canonical domain paths failed validation");
    throw new RuntimeLaunchError("operational_failure", "Container domain state migration failed");
  }
}

/**
 * Prepare under the namespace launch lease, with no live guest using this pair. The launcher owns
 * base-image admission and mapped identity qualification. Failures retain all volume bytes; partial
 * nonempty initialization requires explicit recovery, not implicit repair or recursive chown.
 */
export async function prepareContainerVolumes(options: {
  readonly control: DockerControl;
  readonly preparer: ContainerVolumePreparer;
  readonly namespace: string;
  readonly generation: string;
  readonly baseImageId: string;
  readonly user: { readonly uid: number; readonly gid: number };
  readonly engine: "docker" | "podman";
  readonly signal?: AbortSignal;
}): Promise<PreparedContainerVolumes> {
  const names = containerDataVolumeNames(options.namespace);
  const user = containerVolumeUser(options.user);
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(options.generation) ||
    !/^sha256:[a-f0-9]{64}$/u.test(options.baseImageId)
  )
    throw new RuntimeLaunchError("invalid_launch_spec", "Container preparer identity is invalid");
  const run = async (args: readonly string[]): Promise<DockerCommandResult> => {
    options.signal?.throwIfAborted();
    const result = await options.control.run(args, options.signal);
    options.signal?.throwIfAborted();
    return result;
  };
  for (const role of roles) {
    const name = names[role];
    let inspected = await run(["volume", "inspect", name]);
    if (inspected.exitCode !== 0) {
      const listing = await run(["volume", "ls", "--format", "{{.Name}}"]);
      if (listing.exitCode !== 0 || listing.stdout.split(/\r?\n/u).includes(name))
        throw operational();
      const created = await run([
        "volume",
        "create",
        "--driver",
        "local",
        ...Object.entries(labels(options.namespace, role)).flatMap(([key, value]) => [
          "--label",
          `${key}=${value}`,
        ]),
        name,
      ]);
      if (created.exitCode !== 0) throw operational();
      inspected = await run(["volume", "inspect", name]);
    }
    if (inspected.exitCode !== 0) throw operational();
    const parsed = parse(inspected.stdout);
    const volume = record(Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined);
    const actual = record(volume?.Labels);
    const expected = labels(options.namespace, role);
    if (
      volume?.Name !== name ||
      volume.Driver !== "local" ||
      (volume.Scope !== "local" && !(options.engine === "podman" && volume.Scope === undefined)) ||
      (volume.Options != null &&
        (record(volume.Options) === undefined ||
          Object.keys(record(volume.Options)!).length !== 0)) ||
      actual === undefined ||
      Object.keys(actual).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)
    )
      throw kernelError(
        "conflict",
        "Container data volume identity/schema conflicts; recovery required",
      );
  }
  for (const phase of ["initialize", "validate"] as const) {
    options.signal?.throwIfAborted();
    const ownership = {
      "io.clarvis.managed": "true",
      "io.clarvis.state.namespace": options.namespace,
      "io.clarvis.generation": options.generation,
      "io.clarvis.state.role": `preparer-${phase}`,
    };
    const readonly = phase === "validate";
    const createArgs = [
      "create",
      "--network",
      "none",
      "--read-only",
      "--user",
      readonly ? user : "0:0",
      "--cap-drop",
      "ALL",
      ...(!readonly ? ["--cap-add", "CHOWN"] : []),
      "--security-opt",
      "no-new-privileges=true",
      "--pids-limit",
      "32",
      "--memory",
      "67108864",
      ...Object.entries(ownership).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
      ...roles.flatMap((role) =>
        options.engine === "podman"
          ? ["--volume", `${names[role]}:/${role}:nocopy${readonly ? ",ro" : ""}`]
          : [
              "--mount",
              `type=volume,source=${names[role]},target=/${role},volume-nocopy${readonly ? ",readonly" : ""}`,
            ],
      ),
      ...(options.engine === "podman" ? ["--read-only-tmpfs=false", "--userns=keep-id"] : []),
      "--entrypoint",
      "/bin/sh",
      options.baseImageId,
      "-euc",
      readonly ? validateScript : initializeScript,
      "clarvis-volume-preparer",
      user,
    ];
    const { result, evidence } = await options.preparer.run({
      createArgs,
      labels: ownership,
      policy: {
        user: readonly ? user : "0:0",
        entrypoint: "/bin/sh",
        capabilityAdditions: readonly ? [] : ["CHOWN"],
        pidsLimit: 32,
        memoryBytes: 67_108_864,
        mounts: roles.map((role) => ({
          type: "volume",
          source: names[role],
          target: `/${role}`,
          writable: !readonly,
        })),
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (
      !/^[a-f0-9]{64}$/u.test(evidence.containerId) ||
      evidence.removed !== true ||
      Object.entries(ownership).some(([key, value]) => evidence.labels[key] !== value)
    )
      throw new RuntimeLaunchError(
        "operational_failure",
        "Container preparer cleanup ownership is unconfirmed",
      );
    options.signal?.throwIfAborted();
    if (result.exitCode === 73)
      throw kernelError(
        "conflict",
        "Container data ownership/readiness conflicts; recovery required",
      );
    if (result.exitCode !== 0) throw operational();
  }
  return {
    namespace: options.namespace,
    content: { name: names.content, subpath: "data", target: containerGuestPaths.contentRoot },
    state: { name: names.state, subpath: "data", target: containerGuestPaths.globalRoot },
  };
}
