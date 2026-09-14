import type { Writable } from "node:stream";
import {
  containerRecord,
  exactContainerId,
  hasExactEffectiveCapabilities,
  hasExactTmpfsOptions,
  hasNoNewPrivileges,
  parseContainerInspect,
} from "./container-inspection.ts";
import type {
  ContainerAttachedProcess,
  ContainerCommandResult,
  ContainerControl,
} from "./types.ts";
import { RuntimeLaunchError } from "./types.ts";

export interface ContainerPreparerMount {
  readonly type: "bind" | "volume";
  readonly source: string;
  readonly target: string;
  readonly writable: boolean;
}

export interface ContainerPreparerPolicy {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  readonly user: string;
  readonly entrypoint: string;
  readonly capabilityAdditions: readonly string[];
  readonly pidsLimit: number;
  readonly memoryBytes: number;
  readonly mounts: readonly ContainerPreparerMount[];
  readonly tmpfs?: { readonly target: string; readonly options: readonly string[] };
}

export interface ContainerPreparerResult {
  readonly result: ContainerCommandResult;
  readonly containerId: string;
  readonly labels: Readonly<Record<string, string>>;
}

function cancelled(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Container preparation cancelled");
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}

function waitForExit(
  exited: Promise<number | null>,
  signal: AbortSignal | undefined,
  terminate: () => void,
): Promise<number | null> {
  if (signal === undefined) return exited;
  if (signal.aborted) {
    terminate();
    return Promise.reject(cancelled(signal));
  }
  return new Promise<number | null>((resolve, reject) => {
    const abort = (): void => {
      terminate();
      reject(cancelled(signal));
    };
    signal.addEventListener("abort", abort, { once: true });
    void exited.then(
      (code) => {
        signal.removeEventListener("abort", abort);
        resolve(code);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error("Container preparer process failed"));
      },
    );
  });
}

function containsRequiredLabels(
  actual: Record<string, unknown> | undefined,
  expected: Readonly<Record<string, string>>,
): boolean {
  return (
    actual !== undefined && Object.entries(expected).every(([key, value]) => actual[key] === value)
  );
}

function effectivePreparer(
  root: Record<string, unknown>,
  policy: ContainerPreparerPolicy,
): { id: string; labels: Readonly<Record<string, string>> } | undefined {
  const host = containerRecord(root.HostConfig);
  const config = containerRecord(root.Config);
  const labels = containerRecord(config?.Labels);
  const mounts = Array.isArray(root.Mounts) ? root.Mounts.map(containerRecord) : [];
  const id = exactContainerId(root.Id);
  if (
    id === undefined ||
    host === undefined ||
    config === undefined ||
    !containsRequiredLabels(labels, policy.labels) ||
    host.ReadonlyRootfs !== true ||
    host.Privileged !== false ||
    host.NetworkMode !== "none" ||
    host.PidsLimit !== policy.pidsLimit ||
    host.Memory !== policy.memoryBytes ||
    config.User !== policy.user ||
    !Array.isArray(config.Entrypoint) ||
    config.Entrypoint.length !== 1 ||
    config.Entrypoint[0] !== policy.entrypoint ||
    !hasExactEffectiveCapabilities(root, host, policy.capabilityAdditions) ||
    !hasNoNewPrivileges(host.SecurityOpt) ||
    mounts.some((entry) => entry === undefined) ||
    mounts.length !== policy.mounts.length
  )
    return undefined;
  if (
    policy.mounts.some((expected) => {
      const candidates = mounts.filter((entry) => entry?.Destination === expected.target);
      const candidate = candidates[0];
      return (
        candidates.length !== 1 ||
        candidate?.Type !== expected.type ||
        (expected.type === "bind" ? candidate.Source : candidate.Name) !== expected.source ||
        candidate.RW !== expected.writable
      );
    })
  )
    return undefined;
  const tmpfs = containerRecord(host.Tmpfs);
  if (
    policy.tmpfs === undefined
      ? tmpfs !== undefined && Object.keys(tmpfs).length !== 0
      : tmpfs === undefined ||
        Object.keys(tmpfs).length !== 1 ||
        !hasExactTmpfsOptions(tmpfs[policy.tmpfs.target], policy.tmpfs.options)
  )
    return undefined;
  return { id, labels: labels as Readonly<Record<string, string>> };
}

function preparerIdentity(
  root: Record<string, unknown>,
  policy: ContainerPreparerPolicy,
): { id: string; labels: Readonly<Record<string, string>> } | undefined {
  const config = containerRecord(root.Config);
  const labels = containerRecord(config?.Labels);
  const id = exactContainerId(root.Id);
  return id !== undefined && containsRequiredLabels(labels, policy.labels)
    ? { id, labels: labels as Readonly<Record<string, string>> }
    : undefined;
}

async function inspectOwned(
  control: ContainerControl,
  reference: string,
  policy: ContainerPreparerPolicy,
  signal: AbortSignal,
  requirePolicy = true,
): Promise<{ id: string; labels: Readonly<Record<string, string>> } | undefined> {
  const inspected = await control.run(["container", "inspect", reference], signal);
  if (inspected.exitCode !== 0) {
    const referenceId = exactContainerId(reference);
    const listed = await control.run(
      [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--no-trunc",
        "--filter",
        referenceId === undefined ? `name=^/${policy.name}$` : `id=${referenceId}`,
      ],
      signal,
    );
    if (listed.exitCode !== 0 || listed.stdout.trim() !== "")
      throw new RuntimeLaunchError(
        "operational_failure",
        "Container preparer absence could not be confirmed",
      );
    return undefined;
  }
  const root = parseContainerInspect(inspected.stdout, "Container preparer inspection");
  const identity = preparerIdentity(root, policy);
  if (identity === undefined)
    throw new RuntimeLaunchError(
      "operational_failure",
      "Container preparer ownership did not match admission",
    );
  if (requirePolicy && effectivePreparer(root, policy) === undefined)
    throw new RuntimeLaunchError(
      "unsupported_policy",
      "Container preparer effective policy did not match admission",
    );
  return identity;
}

async function removeOwned(
  control: ContainerControl,
  policy: ContainerPreparerPolicy,
  knownId?: string,
): Promise<void> {
  const signal = AbortSignal.timeout(30_000);
  const owned = await inspectOwned(control, knownId ?? policy.name, policy, signal, false);
  if (owned === undefined) return;
  if (knownId !== undefined && owned.id !== knownId)
    throw new RuntimeLaunchError(
      "operational_failure",
      "Container preparer cleanup identity changed",
    );
  const removed = await control.run(["rm", "--force", owned.id], signal);
  if (removed.exitCode !== 0)
    throw new RuntimeLaunchError("operational_failure", "Container preparer cleanup failed");
  const remaining = await inspectOwned(control, owned.id, policy, signal, false);
  if (remaining !== undefined)
    throw new RuntimeLaunchError(
      "operational_failure",
      "Container preparer removal could not be confirmed",
    );
}

/** Create, inspect, execute and remove one deterministic privileged preparer by exact id. */
export async function runContainerPreparer(options: {
  readonly control: ContainerControl;
  readonly createArgs: readonly string[];
  readonly policy: ContainerPreparerPolicy;
  readonly interactive?: boolean;
  readonly signal?: AbortSignal;
  readonly writeInput?: (stdin: Writable) => Promise<void>;
}): Promise<ContainerPreparerResult> {
  let owned: { id: string; labels: Readonly<Record<string, string>> } | undefined;
  let attached: ContainerAttachedProcess | undefined;
  let primaryError: Error | undefined;
  let outcome: ContainerPreparerResult | undefined;
  try {
    options.signal?.throwIfAborted();
    const args = [...options.createArgs];
    args.splice(1, 0, "--name", options.policy.name);
    const created = await options.control.run(args, options.signal);
    if (created.exitCode !== 0)
      throw new RuntimeLaunchError("operational_failure", "Container preparer create failed");
    const inspectSignal = options.signal ?? AbortSignal.timeout(30_000);
    owned = await inspectOwned(options.control, options.policy.name, options.policy, inspectSignal);
    if (owned === undefined)
      throw new RuntimeLaunchError("operational_failure", "Container preparer disappeared");
    const process = options.control.attach([
      "start",
      "--attach",
      ...(options.interactive === true ? ["--interactive"] : []),
      owned.id,
    ]);
    attached = process;
    if (options.writeInput === undefined) process.stdin.end();
    else await options.writeInput(process.stdin);
    const exitCode = await waitForExit(process.exited, options.signal, () =>
      process.kill("SIGKILL"),
    );
    outcome = {
      result: { exitCode, stdout: "", stderr: "" },
      containerId: owned.id,
      labels: owned.labels,
    };
  } catch (error) {
    primaryError = errorOf(error, "Container preparer failed");
    attached?.kill("SIGKILL");
  }
  let cleanupError: Error | undefined;
  try {
    await removeOwned(options.control, options.policy, owned?.id);
  } catch (error) {
    cleanupError = errorOf(error, "Container preparer cleanup failed");
  }
  if (primaryError !== undefined) {
    if (cleanupError !== undefined)
      throw new AggregateError(
        [primaryError, cleanupError],
        "Container preparer cleanup is unconfirmed",
        { cause: primaryError },
      );
    throw primaryError;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return outcome!;
}
