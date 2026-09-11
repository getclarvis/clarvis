import { createHash } from "node:crypto";
import type { DockerControl, DockerCommandResult } from "./docker-backend.ts";
import { RuntimeLaunchError, type RuntimeLaunchSpec } from "./types.ts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
function parse(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new RuntimeLaunchError("operational_failure", `${label} returned invalid JSON`, {
      cause,
    });
  }
}
function nameFor(generation: string): string {
  return `clarvis-runtime-${generation.toLowerCase().replace(/[^a-z0-9_.-]/gu, "-")}`;
}
/** Engine-owned cache identity partitioned by operator, workspace and image. */
export interface MiseCacheIdentity {
  readonly digest: string;
  readonly name: string;
}
/** Derive the durable cache identity without exposing host paths. */
export function miseCacheIdentity(spec: RuntimeLaunchSpec, user: string): MiseCacheIdentity {
  const digest = `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        schema: 2,
        user,
        ownerId: spec.ownerId,
        projectId: spec.project.id,
        workspaceId: spec.workspace.id,
        imageDigest: spec.imageDigest,
      }),
    )
    .digest("hex")}`;
  return { digest, name: `clarvis-mise-v2-${digest.slice("sha256:".length)}` };
}
async function successful(
  control: DockerControl,
  args: readonly string[],
  label: string,
): Promise<DockerCommandResult> {
  const result = await control.run(args);
  if (result.exitCode !== 0) throw new RuntimeLaunchError("operational_failure", `${label} failed`);
  return result;
}

function validMiseCache(
  value: unknown,
  cache: MiseCacheIdentity,
  engine: "docker" | "podman",
): boolean {
  const root = record(Array.isArray(value) ? value[0] : value);
  const labels = record(root?.Labels);
  return (
    root?.Name === cache.name &&
    root?.Driver === "local" &&
    (root?.Scope === "local" || (engine === "podman" && root?.Scope === undefined)) &&
    labels?.["io.clarvis.runtime.mise-cache"] === "true" &&
    labels?.["io.clarvis.runtime.mise-cache.schema"] === "2" &&
    labels?.["io.clarvis.runtime.mise-cache.identity"] === cache.digest
  );
}

/** Create and verify the engine-owned volume before attaching any guest. */
export async function prepareMiseCache(
  control: DockerControl,
  cache: MiseCacheIdentity,
  engine: "docker" | "podman" = "docker",
): Promise<void> {
  let inspected = await control.run(["volume", "inspect", cache.name]);
  if (inspected.exitCode !== 0) {
    await successful(
      control,
      [
        "volume",
        "create",
        "--label",
        "io.clarvis.runtime.mise-cache=true",
        "--label",
        "io.clarvis.runtime.mise-cache.schema=2",
        "--label",
        `io.clarvis.runtime.mise-cache.identity=${cache.digest}`,
        cache.name,
      ],
      `${engine} mise cache volume create`,
    );
    inspected = await successful(
      control,
      ["volume", "inspect", cache.name],
      `${engine} mise cache volume inspect`,
    );
  }
  if (
    !validMiseCache(parse(inspected.stdout, "container mise cache volume inspect"), cache, engine)
  ) {
    throw new RuntimeLaunchError(
      "unsupported_policy",
      "Container mise cache volume did not match the host-owned workspace identity",
    );
  }
}

/** Initialize only a private volume subdirectory from the immutable image; never mount a workspace. */
export async function prepareCacheOwnership(
  control: DockerControl,
  spec: RuntimeLaunchSpec,
  cache: MiseCacheIdentity,
  user: string,
  engine: "docker" | "podman" = "docker",
): Promise<void> {
  const name = `${nameFor(spec.generation)}-cache-init`;
  const script = [
    "if [ ! -e /cache/ready ]; then",
    "  test ! -L /cache/data",
    "  mkdir -p /cache/data",
    "  if [ -d /mise ]; then cp -a /mise/. /cache/data/; fi",
    '  chown -hR -- "$1" /cache/data',
    "  : > /cache/ready",
    "fi",
    "test ! -L /cache/data && test -d /cache/data",
    'test "$(stat -c %u:%g /cache/data)" = "$1"',
  ].join("\n");
  try {
    await successful(
      control,
      [
        "run",
        "--rm",
        "--name",
        name,
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
        "32",
        "--memory",
        "67108864",
        ...(engine === "podman"
          ? ["--volume", `${cache.name}:/cache:nocopy`, "--read-only-tmpfs=false", "--userns=host"]
          : ["--mount", `type=volume,source=${cache.name},target=/cache,volume-nocopy`]),
        "--entrypoint",
        "/bin/sh",
        spec.imageDigest,
        "-euc",
        script,
        "clarvis-cache-init",
        user,
      ],
      `${engine} mise cache ownership initialization`,
    );
  } catch (error) {
    await control.run(["rm", "--force", name]).catch(() => undefined);
    throw error;
  }
}
