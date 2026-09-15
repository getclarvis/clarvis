#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const RUNTIME_RELEASE_MANIFEST_ASSET = "runtime-release.json";
export const RUNTIME_SOURCE_REPOSITORY = "getclarvis/clarvis";
export const RUNTIME_TARGETS = ["linux-x64", "linux-arm64"] as const;

export interface RuntimeReleaseTarget {
  readonly base: {
    readonly image: string;
    readonly digest: `sha256:${string}`;
    readonly abi: "clarvis-linux-glibc-v1";
  };
  readonly artifact: { readonly asset: string; readonly sha256: string; readonly size: number };
  readonly kernel_wire_version: 11;
  readonly broker_version: 1;
  readonly channel_version: 1;
}

export interface RuntimeReleaseManifest {
  readonly schema_version: 2;
  readonly version: string;
  readonly source_revision: string;
  readonly targets: Readonly<Record<(typeof RUNTIME_TARGETS)[number], RuntimeReleaseTarget>>;
}

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const hashPattern = /^[a-f0-9]{64}$/u;
const imagePattern = /^[a-z0-9][a-z0-9._:/-]*$/u;
const assetPattern = /^clarvis-kernel-linux-(?:x64|arm64)\.tar\.gz$/u;

function exact(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    throw new Error(`${label} has unknown or missing fields`);
  return object;
}

function target(value: unknown, expected: (typeof RUNTIME_TARGETS)[number]): RuntimeReleaseTarget {
  const root = exact(
    value,
    ["base", "artifact", "kernel_wire_version", "broker_version", "channel_version"],
    "runtime target",
  );
  const base = exact(root.base, ["image", "digest", "abi"], "runtime base");
  const artifact = exact(root.artifact, ["asset", "sha256", "size"], "runtime artifact");
  if (
    typeof base.image !== "string" ||
    !imagePattern.test(base.image) ||
    typeof base.digest !== "string" ||
    !digestPattern.test(base.digest) ||
    base.abi !== "clarvis-linux-glibc-v1" ||
    artifact.asset !== `clarvis-kernel-${expected}.tar.gz` ||
    !assetPattern.test(artifact.asset) ||
    typeof artifact.sha256 !== "string" ||
    !hashPattern.test(artifact.sha256) ||
    typeof artifact.size !== "number" ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    artifact.size > 512 * 1024 * 1024 ||
    root.kernel_wire_version !== 11 ||
    root.broker_version !== 1 ||
    root.channel_version !== 1
  )
    throw new Error("runtime target identity is invalid");
  return {
    base: {
      image: base.image,
      digest: base.digest as `sha256:${string}`,
      abi: "clarvis-linux-glibc-v1",
    },
    artifact: { asset: artifact.asset, sha256: artifact.sha256, size: artifact.size },
    kernel_wire_version: 11,
    broker_version: 1,
    channel_version: 1,
  };
}

/** Parse the closed schema-2 mapping from product release to base/artifact pairs. */
export function parseRuntimeReleaseManifest(
  source: string,
  expectedVersion?: string,
): RuntimeReleaseManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (cause) {
    throw new Error("runtime release manifest is not valid JSON", { cause });
  }
  const root = exact(
    parsed,
    ["schema_version", "version", "source_revision", "targets"],
    "runtime release manifest",
  );
  if (root.schema_version !== 2) throw new Error("runtime release manifest schema is unsupported");
  if (
    typeof root.version !== "string" ||
    !versionPattern.test(root.version) ||
    (expectedVersion !== undefined && root.version !== expectedVersion)
  )
    throw new Error("runtime release manifest version is invalid");
  if (typeof root.source_revision !== "string" || !revisionPattern.test(root.source_revision))
    throw new Error("runtime release manifest source revision is invalid");
  const targets = exact(root.targets, RUNTIME_TARGETS, "runtime release targets");
  return {
    schema_version: 2,
    version: root.version,
    source_revision: root.source_revision,
    targets: {
      "linux-x64": target(targets["linux-x64"], "linux-x64"),
      "linux-arm64": target(targets["linux-arm64"], "linux-arm64"),
    },
  };
}

/** Validate and normalize a schema-2 value created by release automation. */
export function createRuntimeReleaseManifest(
  value: RuntimeReleaseManifest,
): RuntimeReleaseManifest {
  return parseRuntimeReleaseManifest(JSON.stringify(value), value.version);
}

async function main(): Promise<void> {
  const [input, output] = process.argv.slice(2);
  if (input === undefined || output === undefined || process.argv.length !== 4)
    throw new Error("usage: release-manifest.ts <input-json> <output>");
  const manifest = parseRuntimeReleaseManifest(await Bun.file(input).text());
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
}

if (import.meta.main) await main();
