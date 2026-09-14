import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { kernelError } from "../core/errors.ts";
import type { CachedRuntimeArtifact } from "./runtime-artifact.ts";
import type { ContainerControl } from "./types.ts";
import { RuntimeLaunchError } from "./types.ts";

const idPattern = /^(?:sha256:)?[a-f0-9]{64}$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RuntimeLaunchError("operational_failure", "Container artifact inspection is invalid");
  }
}

function labels(artifact: CachedRuntimeArtifact, digest: `sha256:${string}`) {
  return {
    "io.clarvis.managed": "true",
    "io.clarvis.artifact.schema": "1",
    "io.clarvis.artifact.digest": digest,
    "io.clarvis.artifact.target": artifact.manifest.target,
    "io.clarvis.artifact.abi": artifact.manifest.baseAbi,
  } as const;
}

/** Engine artifact volume identity; the complete archive hash is never shortened. */
function runtimeArtifactVolumeName(digest: `sha256:${string}`): string {
  if (!/^sha256:[a-f0-9]{64}$/u.test(digest))
    throw new RuntimeLaunchError("invalid_launch_spec", "Container artifact digest is invalid");
  return `clarvis-artifact-v1-${digest.slice("sha256:".length)}`;
}

async function removePreparer(
  control: ContainerControl,
  name: string,
  generation: string,
): Promise<void> {
  const inspection = await control.run(["container", "inspect", name]);
  if (inspection.exitCode !== 0)
    throw new RuntimeLaunchError("operational_failure", "Artifact preparer inspection failed");
  const root = record(
    Array.isArray(parsed(inspection.stdout))
      ? (parsed(inspection.stdout) as unknown[])[0]
      : undefined,
  );
  const config = record(root?.Config);
  const foundLabels = record(config?.Labels);
  const id = root?.Id;
  if (
    typeof id !== "string" ||
    !idPattern.test(id) ||
    foundLabels?.["io.clarvis.generation"] !== generation
  )
    throw new RuntimeLaunchError(
      "operational_failure",
      "Artifact preparer ownership is unconfirmed",
    );
  const removed = await control.run(["rm", "--force", id]);
  if (removed.exitCode !== 0)
    throw new RuntimeLaunchError("operational_failure", "Artifact preparer cleanup failed");
}

/** Transfer one already verified archive into an immutable, label-checked engine volume. */
export async function prepareRuntimeArtifactVolume(options: {
  readonly control: ContainerControl;
  readonly engine: "docker" | "podman";
  readonly baseImageId: `sha256:${string}`;
  readonly artifact: CachedRuntimeArtifact;
  readonly digest: `sha256:${string}`;
  readonly size: number;
  readonly generation: string;
  readonly signal?: AbortSignal;
}): Promise<{ readonly name: string; readonly subpath: "payload" }> {
  const name = runtimeArtifactVolumeName(options.digest);
  const expected = labels(options.artifact, options.digest);
  const inspect = await options.control.run(["volume", "inspect", name], options.signal);
  const exists = inspect.exitCode === 0;
  if (!exists) {
    const created = await options.control.run(
      [
        "volume",
        "create",
        ...Object.entries(expected).flatMap(([key, value]) => ["--label", `${key}=${value}`]),
        name,
      ],
      options.signal,
    );
    if (created.exitCode !== 0)
      throw new RuntimeLaunchError("operational_failure", "Artifact volume create failed");
  }
  const volumeInspect = await options.control.run(["volume", "inspect", name], options.signal);
  const volumeRoot = record(
    Array.isArray(parsed(volumeInspect.stdout))
      ? (parsed(volumeInspect.stdout) as unknown[])[0]
      : undefined,
  );
  const actual = record(volumeRoot?.Labels);
  if (
    volumeInspect.exitCode !== 0 ||
    volumeRoot?.Name !== name ||
    actual === undefined ||
    Object.keys(actual).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => actual[key] !== value)
  )
    throw kernelError("conflict", "Container artifact volume identity conflicts");
  const invoke = async (mode: "prepare" | "verify"): Promise<void> => {
    const preparer = `clarvis-artifact-${mode}-${options.generation}`;
    const args = [
      "create",
      "--name",
      preparer,
      "--label",
      "io.clarvis.managed=true",
      "--label",
      `io.clarvis.generation=${options.generation}`,
      "--label",
      `io.clarvis.role=artifact-${mode}`,
      "--interactive",
      "--network",
      "none",
      "--read-only",
      "--user",
      "0:0",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--pids-limit",
      "32",
      "--memory",
      "2147483648",
      "--tmpfs",
      "/incoming:rw,nosuid,nodev,noexec,size=805306368",
      ...(options.engine === "docker"
        ? [
            "--mount",
            `type=volume,source=${name},target=/artifact,volume-nocopy${mode === "verify" ? ",readonly" : ""}`,
          ]
        : [
            "--volume",
            `${name}:/artifact:nocopy${mode === "verify" ? ",ro" : ""}`,
            "--read-only-tmpfs=false",
          ]),
      "--entrypoint",
      "/usr/local/libexec/clarvis-prepare-artifact",
      options.baseImageId,
      options.digest.slice("sha256:".length),
      String(options.size),
      mode,
    ];
    const created = await options.control.run(args, options.signal);
    if (created.exitCode !== 0)
      throw new RuntimeLaunchError("operational_failure", "Artifact preparer create failed");
    try {
      const process = options.control.attach(["start", "--attach", "--interactive", preparer]);
      if (mode === "prepare")
        await pipeline(createReadStream(options.artifact.archivePath), process.stdin, {
          signal: options.signal,
        });
      else process.stdin.end();
      const exitCode = await process.exited;
      if (exitCode !== 0)
        throw new RuntimeLaunchError("operational_failure", "Artifact preparer validation failed");
    } finally {
      await removePreparer(options.control, preparer, options.generation);
    }
  };
  try {
    await invoke(exists ? "verify" : "prepare");
  } catch (error) {
    if (!exists) throw error;
    throw kernelError("conflict", "Container artifact cache is incomplete or corrupted");
  }
  return { name, subpath: "payload" };
}
