#!/usr/bin/env bun
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_ARTIFACT_REPOSITORY,
  RUNTIME_BASE_IMAGE,
  RUNTIME_BUILD_IMAGE,
  RUNTIME_IMAGE_REPOSITORY,
  RUNTIME_PROTOCOL_REVISION,
} from "./build-image.ts";

export const RUNTIME_RELEASE_MANIFEST_ASSET = "runtime-release.json";
export const RUNTIME_RELEASE_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
export const RUNTIME_SOURCE_REPOSITORY = "getclarvis/clarvis";

const PRODUCT_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export interface RuntimeReleaseManifest {
  readonly schema: 1;
  readonly repository: typeof RUNTIME_SOURCE_REPOSITORY;
  readonly version: string;
  readonly source_revision: string;
  readonly protocol_revision: typeof RUNTIME_PROTOCOL_REVISION;
  readonly platforms: typeof RUNTIME_RELEASE_PLATFORMS;
  readonly artifact_image: string;
  readonly runtime_image: string;
  readonly build_image: typeof RUNTIME_BUILD_IMAGE;
  readonly base_image: typeof RUNTIME_BASE_IMAGE;
}

export interface RuntimeReleaseManifestInput {
  readonly version: string;
  readonly sourceRevision: string;
  readonly artifactImage: string;
  readonly runtimeImage: string;
}

function assertExactKeys(value: Record<string, unknown>): void {
  const expected = [
    "artifact_image",
    "base_image",
    "build_image",
    "platforms",
    "protocol_revision",
    "repository",
    "schema",
    "source_revision",
    "runtime_image",
    "version",
  ].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("runtime release manifest has an unexpected field set");
  }
}

function assertImage(value: unknown, repository: string, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith(`${repository}@`) ||
    !DIGEST.test(value.slice(repository.length + 1))
  ) {
    throw new Error(`${label} must be ${repository}@sha256:<64 lowercase hex>`);
  }
}

function assertIdentity(input: RuntimeReleaseManifestInput): void {
  if (!PRODUCT_VERSION.test(input.version)) {
    throw new Error("runtime release version must be an exact Clarvis product version");
  }
  if (!SOURCE_REVISION.test(input.sourceRevision)) {
    throw new Error("runtime release source revision must be a complete lowercase Git commit");
  }
  assertImage(input.artifactImage, RUNTIME_ARTIFACT_REPOSITORY, "runtime artifact image");
  assertImage(input.runtimeImage, RUNTIME_IMAGE_REPOSITORY, "runtime image");
}

/** Create the canonical mapping from one product release to immutable OCI identities. */
export function createRuntimeReleaseManifest(
  input: RuntimeReleaseManifestInput,
): RuntimeReleaseManifest {
  assertIdentity(input);
  return {
    schema: 1,
    repository: RUNTIME_SOURCE_REPOSITORY,
    version: input.version,
    source_revision: input.sourceRevision,
    protocol_revision: RUNTIME_PROTOCOL_REVISION,
    platforms: RUNTIME_RELEASE_PLATFORMS,
    artifact_image: input.artifactImage,
    runtime_image: input.runtimeImage,
    build_image: RUNTIME_BUILD_IMAGE,
    base_image: RUNTIME_BASE_IMAGE,
  };
}

/** Parse an externally supplied runtime release manifest without accepting drift or extra fields. */
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
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("runtime release manifest must be an object");
  }
  const value = parsed as Record<string, unknown>;
  assertExactKeys(value);
  if (
    value.schema !== 1 ||
    value.repository !== RUNTIME_SOURCE_REPOSITORY ||
    value.protocol_revision !== RUNTIME_PROTOCOL_REVISION ||
    value.build_image !== RUNTIME_BUILD_IMAGE ||
    value.base_image !== RUNTIME_BASE_IMAGE
  ) {
    throw new Error("runtime release manifest identity does not match this Clarvis source");
  }
  if (
    !Array.isArray(value.platforms) ||
    value.platforms.length !== RUNTIME_RELEASE_PLATFORMS.length ||
    value.platforms.some((platform, index) => platform !== RUNTIME_RELEASE_PLATFORMS[index])
  ) {
    throw new Error("runtime release manifest has an unsupported platform set");
  }
  if (typeof value.version !== "string" || !PRODUCT_VERSION.test(value.version)) {
    throw new Error("runtime release manifest has an invalid product version");
  }
  if (expectedVersion !== undefined && value.version !== expectedVersion) {
    throw new Error("runtime release manifest product version does not match the release");
  }
  if (typeof value.source_revision !== "string" || !SOURCE_REVISION.test(value.source_revision)) {
    throw new Error("runtime release manifest has an invalid source revision");
  }
  assertImage(value.artifact_image, RUNTIME_ARTIFACT_REPOSITORY, "runtime artifact image");
  assertImage(value.runtime_image, RUNTIME_IMAGE_REPOSITORY, "runtime image");
  return value as unknown as RuntimeReleaseManifest;
}

async function productVersion(): Promise<string> {
  const product: unknown = await Bun.file(new URL("../../package.json", import.meta.url)).json();
  if (
    typeof product !== "object" ||
    product === null ||
    !("version" in product) ||
    typeof product.version !== "string"
  ) {
    throw new Error("root package.json has no product version");
  }
  return product.version;
}

async function main(): Promise<void> {
  const [tag, sourceRevision, artifactImage, runtimeImage, output] = process.argv.slice(2);
  if (
    tag === undefined ||
    sourceRevision === undefined ||
    artifactImage === undefined ||
    runtimeImage === undefined ||
    output === undefined ||
    process.argv.length !== 7
  ) {
    throw new Error(
      "usage: release-manifest.ts <vVersion> <source-revision> <artifact@digest> <runtime@digest> <output>",
    );
  }
  const version = await productVersion();
  if (tag !== `v${version}`)
    throw new Error("runtime release tag differs from the product version");
  const manifest = createRuntimeReleaseManifest({
    version,
    sourceRevision,
    artifactImage,
    runtimeImage,
  });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`${output}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
