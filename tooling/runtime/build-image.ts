import { createHash } from "node:crypto";

export const RUNTIME_PROTOCOL_REVISION = "13";
export const RUNTIME_ARTIFACT_REPOSITORY = "ghcr.io/getclarvis/clarvis-runtime-artifact";
export const RUNTIME_CANDIDATE_ARTIFACT_REPOSITORY =
  "ghcr.io/getclarvis/clarvis-runtime-candidate-artifact";
export const RUNTIME_CANDIDATE_IMAGE_REPOSITORY = "ghcr.io/getclarvis/clarvis-runtime-candidate";
export const RUNTIME_IMAGE_REPOSITORY = "ghcr.io/getclarvis/clarvis-runtime";
export const RUNTIME_BUILD_IMAGE =
  "docker.io/oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef";
export const RUNTIME_BASE_IMAGE =
  "docker.io/library/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171";
export const RUNTIME_MISE_VERSION = "2026.8.2";
export const RUNTIME_MISE_SHA256_AMD64 =
  "62899928f45a7d8e623f30663f490b0dbc90c4e1fc8935863b87c56626cf5950";
export const RUNTIME_MISE_SHA256_ARM64 =
  "aa47c61c3de911ece9e8d4486495370f9600d0b4d767de004eb5380b0906be78";

const PINNED_IMAGE = /^[a-z0-9][a-z0-9._:/-]*@sha256:[a-f0-9]{64}$/u;
const LOCAL_IMAGE = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?$/u;
const PRODUCT_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const SOURCE_REVISION = /^[0-9a-f]{40}$/u;

export interface RuntimeImageMetadata {
  readonly version: string;
  readonly sourceRevision: string;
}

export interface RuntimeImageBuildPlan {
  readonly engine: "docker" | "podman";
  readonly mode: "artifact" | "development" | "release";
  readonly outputImage: string;
  readonly commands: readonly (readonly string[])[];
}

function assertMetadata(metadata: RuntimeImageMetadata): void {
  if (!PRODUCT_VERSION.test(metadata.version)) {
    throw new Error("runtime image version must be the exact Clarvis product version");
  }
  if (!SOURCE_REVISION.test(metadata.sourceRevision)) {
    throw new Error("runtime image source revision must be a complete lowercase Git commit");
  }
}

function assertLocalImage(image: string): void {
  if (!LOCAL_IMAGE.test(image) || image.includes("@")) {
    throw new Error("runtime output image must be an explicit local name or name:tag");
  }
}

function assertReleasedArtifact(image: string, candidate = false): void {
  const repository = candidate
    ? RUNTIME_CANDIDATE_ARTIFACT_REPOSITORY
    : RUNTIME_ARTIFACT_REPOSITORY;
  if (!PINNED_IMAGE.test(image) || !image.startsWith(`${repository}@sha256:`)) {
    throw new Error(`runtime artifact must be ${repository}@sha256:<64 lowercase hex>`);
  }
}

function finalImageBuildArgs(
  artifactImage: string,
  outputImage: string,
  metadata: RuntimeImageMetadata,
  development: boolean,
): string[] {
  assertMetadata(metadata);
  assertLocalImage(outputImage);
  return [
    "build",
    "--file",
    "Containerfile.runtime",
    "--build-arg",
    `BASE_IMAGE=${RUNTIME_BASE_IMAGE}`,
    "--build-arg",
    `MISE_VERSION=${RUNTIME_MISE_VERSION}`,
    "--build-arg",
    `MISE_SHA256_AMD64=${RUNTIME_MISE_SHA256_AMD64}`,
    "--build-arg",
    `MISE_SHA256_ARM64=${RUNTIME_MISE_SHA256_ARM64}`,
    "--build-arg",
    `RUNTIME_ARTIFACT=${artifactImage}`,
    "--build-arg",
    `RUNTIME_VERSION=${metadata.version}`,
    "--build-arg",
    `SOURCE_REVISION=${metadata.sourceRevision}`,
    "--build-arg",
    `DEVELOPMENT=${String(development)}`,
    "--tag",
    outputImage,
    ".",
  ];
}

/** Build a runnable image only from the canonical released OCI artifact. */
export function runtimeImageBuildArgs(
  artifactImage: string,
  outputImage: string,
  metadata: RuntimeImageMetadata,
): string[] {
  assertReleasedArtifact(artifactImage);
  return finalImageBuildArgs(artifactImage, outputImage, metadata, false);
}

/** Build the source-only carrier used by release automation and local development. */
export function runtimeArtifactBuildArgs(
  outputImage: string,
  metadata: RuntimeImageMetadata,
): string[] {
  assertMetadata(metadata);
  assertLocalImage(outputImage);
  return [
    "build",
    "--file",
    "Containerfile.runtime-development",
    "--build-arg",
    `BUILD_IMAGE=${RUNTIME_BUILD_IMAGE}`,
    "--build-arg",
    `RUNTIME_VERSION=${metadata.version}`,
    "--build-arg",
    `SOURCE_REVISION=${metadata.sourceRevision}`,
    "--tag",
    outputImage,
    ".",
  ];
}

/** Derive a command-owned carrier tag without treating it as a released identity. */
export function developmentArtifactImage(outputImage: string): string {
  assertLocalImage(outputImage);
  const suffix = createHash("sha256").update(outputImage).digest("hex").slice(0, 16);
  return `clarvis-runtime-artifact:development-${suffix}`;
}

/** Parse one release, carrier-only, or current-source development image plan. */
export function runtimeImageBuildPlan(
  args: readonly string[],
  metadata: RuntimeImageMetadata,
): RuntimeImageBuildPlan {
  let candidate = false;
  let engine: "docker" | "podman" = "docker";
  let mode: RuntimeImageBuildPlan["mode"] = "release";
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--candidate") {
      candidate = true;
    } else if (value === "--engine") {
      const selected = args[index + 1];
      if (selected !== "docker" && selected !== "podman") {
        throw new Error("runtime engine must be docker or podman");
      }
      engine = selected;
      index += 1;
    } else if (value === "--development" || value === "--artifact-only") {
      if (mode !== "release") {
        throw new Error("runtime image build mode may be selected only once");
      }
      mode = value === "--development" ? "development" : "artifact";
    } else if (value.startsWith("--")) {
      throw new Error(`unknown runtime image build option: ${value}`);
    } else {
      positional.push(value);
    }
  }

  if (candidate && mode !== "release")
    throw new Error("candidate mode requires an immutable carrier");
  if (mode === "release") {
    const [artifactImage, outputImage] = positional;
    if (artifactImage === undefined || outputImage === undefined || positional.length !== 2) {
      throw new Error(
        "usage: bun run runtime:build -- [--engine docker|podman] <runtime-artifact@sha256:digest> <local-name:tag>",
      );
    }
    assertReleasedArtifact(artifactImage, candidate);
    if (candidate && !outputImage.startsWith(`${RUNTIME_CANDIDATE_IMAGE_REPOSITORY}:`)) {
      throw new Error("candidate output must use the candidate image repository");
    }
    return {
      engine,
      mode,
      outputImage,
      commands: [finalImageBuildArgs(artifactImage, outputImage, metadata, false)],
    };
  }

  const [outputImage] = positional;
  if (outputImage === undefined || positional.length !== 1) {
    throw new Error(
      `usage: bun run runtime:build -- --${mode === "development" ? "development" : "artifact-only"} [--engine docker|podman] <local-name:tag>`,
    );
  }
  const artifactImage = mode === "artifact" ? outputImage : developmentArtifactImage(outputImage);
  const commands: string[][] = [runtimeArtifactBuildArgs(artifactImage, metadata)];
  if (mode === "development") {
    commands.push(finalImageBuildArgs(artifactImage, outputImage, metadata, true));
  }
  return { engine, mode, outputImage, commands };
}

async function productVersion(): Promise<string> {
  const value: unknown = await Bun.file(new URL("../../package.json", import.meta.url)).json();
  if (
    typeof value !== "object" ||
    value === null ||
    !("version" in value) ||
    typeof value.version !== "string"
  ) {
    throw new Error("root package.json has no product version");
  }
  return value.version;
}

async function sourceRevision(): Promise<string> {
  const supplied = process.env.CLARVIS_RUNTIME_SOURCE_REVISION;
  if (supplied !== undefined) return supplied;
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const revision = (await new Response(child.stdout).text()).trim();
  if ((await child.exited) !== 0) {
    throw new Error("git failed to resolve the runtime source revision");
  }
  return revision;
}

async function run(): Promise<void> {
  const plan = runtimeImageBuildPlan(process.argv.slice(2), {
    version: await productVersion(),
    sourceRevision: await sourceRevision(),
  });
  for (const args of plan.commands) {
    const child = Bun.spawn([plan.engine, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      process.exitCode = exitCode;
      return;
    }
  }
  const inspect = Bun.spawn(
    [plan.engine, "image", "inspect", "--format", "{{.Id}}", plan.outputImage],
    { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
  );
  const digest = runtimeLocalImageId((await new Response(inspect.stdout).text()).trim());
  if ((await inspect.exited) !== 0 || digest === undefined) {
    throw new Error("runtime image build produced no immutable local image ID");
  }
  process.stdout.write(`${plan.outputImage}@${digest}\n`);
}

/** Canonicalize only complete OCI local image IDs, never tags or manifest references. */
export function runtimeLocalImageId(value: string): string | undefined {
  if (/^sha256:[a-f0-9]{64}$/u.test(value)) return value;
  return /^[a-f0-9]{64}$/u.test(value) ? `sha256:${value}` : undefined;
}

if (import.meta.main) await run();
