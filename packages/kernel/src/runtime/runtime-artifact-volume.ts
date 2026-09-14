import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { kernelError } from "../core/errors.ts";
import type { CachedRuntimeArtifact } from "./runtime-artifact.ts";
import { runContainerPreparer } from "./container-preparer.ts";
import type { ContainerControl } from "./types.ts";
import { RuntimeLaunchError } from "./types.ts";

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
  const createVolume = async (): Promise<void> => {
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
  };
  const inspectVolume = async (): Promise<void> => {
    const volumeInspect = await options.control.run(["volume", "inspect", name], options.signal);
    const parsedInspection = parsed(volumeInspect.stdout);
    const volumeRoot = record(Array.isArray(parsedInspection) ? parsedInspection[0] : undefined);
    const actual = record(volumeRoot?.Labels);
    if (
      volumeInspect.exitCode !== 0 ||
      volumeRoot?.Name !== name ||
      actual === undefined ||
      Object.keys(actual).length !== Object.keys(expected).length ||
      Object.entries(expected).some(([key, value]) => actual[key] !== value)
    )
      throw kernelError("conflict", "Container artifact volume identity conflicts");
  };
  const inspect = await options.control.run(["volume", "inspect", name], options.signal);
  const exists = inspect.exitCode === 0;
  if (!exists) await createVolume();
  await inspectVolume();
  const invoke = async (mode: "prepare" | "verify"): Promise<number | null> => {
    const preparer = `clarvis-artifact-${mode}-${options.generation}`;
    const preparerLabels = {
      "io.clarvis.managed": "true",
      "io.clarvis.generation": options.generation,
      "io.clarvis.role": `artifact-${mode}`,
    };
    const tmpfsOptions = ["rw", "nosuid", "nodev", "noexec", "size=805306368"];
    const args = [
      "create",
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
      `/incoming:${tmpfsOptions.join(",")}`,
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
    const completed = await runContainerPreparer({
      control: options.control,
      createArgs: args,
      policy: {
        name: preparer,
        labels: preparerLabels,
        user: "0:0",
        entrypoint: "/usr/local/libexec/clarvis-prepare-artifact",
        capabilityAdditions: [],
        pidsLimit: 32,
        memoryBytes: 2_147_483_648,
        mounts: [
          { type: "volume", source: name, target: "/artifact", writable: mode === "prepare" },
        ],
        tmpfs: {
          target: "/incoming",
          options: [
            ...tmpfsOptions,
            ...(options.engine === "podman" ? ["rprivate", "tmpcopyup"] : []),
          ],
        },
      },
      interactive: true,
      signal: options.signal,
      writeInput: async (stdin) => {
        if (mode === "prepare")
          await pipeline(createReadStream(options.artifact.archivePath), stdin, {
            signal: options.signal,
          });
        else stdin.end();
      },
    });
    return completed.result.exitCode;
  };
  if (!exists) {
    const exitCode = await invoke("prepare");
    if (exitCode !== 0)
      throw new RuntimeLaunchError("operational_failure", "Artifact preparer validation failed");
    return { name, subpath: "payload" };
  }
  let verifyExit: number | null;
  try {
    verifyExit = await invoke("verify");
  } catch (error) {
    if (options.signal?.aborted === true) throw options.signal.reason ?? error;
    throw kernelError("conflict", "Container artifact cache inspection failed");
  }
  if (verifyExit === 0) return { name, subpath: "payload" };
  const consumers = await options.control.run(
    ["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `volume=${name}`],
    options.signal,
  );
  if (consumers.exitCode !== 0 || consumers.stdout.trim() !== "")
    throw kernelError("conflict", "Container artifact cache is incomplete and still in use");
  const removed = await options.control.run(["volume", "rm", name], options.signal);
  if (removed.exitCode !== 0)
    throw kernelError("conflict", "Container artifact cache removal is unconfirmed");
  const afterRemoval = await options.control.run(["volume", "inspect", name], options.signal);
  const listed = await options.control.run(
    ["volume", "ls", "--quiet", "--filter", `name=${name}`],
    options.signal,
  );
  const exactStillListed = listed.stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .includes(name);
  if (afterRemoval.exitCode === 0 || listed.exitCode !== 0 || exactStillListed)
    throw kernelError("conflict", "Container artifact cache removal is unconfirmed");
  await createVolume();
  await inspectVolume();
  const prepareExit = await invoke("prepare");
  if (prepareExit !== 0)
    throw new RuntimeLaunchError("operational_failure", "Artifact preparer validation failed");
  return { name, subpath: "payload" };
}
