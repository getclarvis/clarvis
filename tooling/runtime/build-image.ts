#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const RUNTIME_BUILD_IMAGE =
  "docker.io/oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef";
export const RUNTIME_BASE_IMAGE =
  "docker.io/library/debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171";
export const RUNTIME_BASE_ABI = "clarvis-linux-glibc-v1";
export const RUNTIME_MISE_VERSION = "2026.8.2";
export const RUNTIME_MISE_SHA256_AMD64 =
  "62899928f45a7d8e623f30663f490b0dbc90c4e1fc8935863b87c56626cf5950";
export const RUNTIME_MISE_SHA256_ARM64 =
  "aa47c61c3de911ece9e8d4486495370f9600d0b4d767de004eb5380b0906be78";

export interface RuntimeBaseBuildPlan {
  readonly engine: "docker" | "podman";
  readonly target: "linux-x64" | "linux-arm64";
  readonly tag: string;
  readonly revision: string;
  readonly args: readonly string[];
}

const imageName = /^[a-z0-9][a-z0-9._/-]*(?::[a-z0-9._-]+)?$/u;

/** The base identity changes only when its recipe, pinned inputs, target or ABI changes. */
export function runtimeBaseRevision(target: RuntimeBaseBuildPlan["target"]): string {
  const root = new URL("../..", import.meta.url);
  return createHash("sha256")
    .update(
      JSON.stringify({
        schema: 1,
        target,
        abi: RUNTIME_BASE_ABI,
        base: RUNTIME_BASE_IMAGE,
        mise: [RUNTIME_MISE_VERSION, RUNTIME_MISE_SHA256_AMD64, RUNTIME_MISE_SHA256_ARM64],
      }),
    )
    .update(readFileSync(new URL("Containerfile.runtime", root)))
    .update(readFileSync(new URL("tooling/runtime/prepare-artifact.sh", root)))
    .digest("hex");
}

/** Strict CLI parser for the version-independent base image build. */
export function runtimeBaseBuildPlan(args: readonly string[]): RuntimeBaseBuildPlan {
  let engine: RuntimeBaseBuildPlan["engine"] | undefined;
  let target: RuntimeBaseBuildPlan["target"] | undefined;
  let tag: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === "--engine" && (value === "docker" || value === "podman")) engine = value;
    else if (flag === "--target" && (value === "linux-x64" || value === "linux-arm64"))
      target = value;
    else if (flag === "--tag" && value !== undefined && imageName.test(value)) tag = value;
    else throw new Error(`invalid runtime base build option: ${flag ?? "<missing>"}`);
    index++;
  }
  if (engine === undefined || target === undefined || tag === undefined)
    throw new Error(
      "usage: runtime:base:build --engine docker|podman --target linux-x64|linux-arm64 --tag name:tag",
    );
  const revision = runtimeBaseRevision(target);
  return {
    engine,
    target,
    tag,
    revision,
    args: [
      "build",
      "--file",
      "Containerfile.runtime",
      "--platform",
      target === "linux-x64" ? "linux/amd64" : "linux/arm64",
      "--build-arg",
      `BASE_IMAGE=${RUNTIME_BASE_IMAGE}`,
      "--build-arg",
      `BASE_REVISION=${revision}`,
      "--build-arg",
      `MISE_VERSION=${RUNTIME_MISE_VERSION}`,
      "--build-arg",
      `MISE_SHA256_AMD64=${RUNTIME_MISE_SHA256_AMD64}`,
      "--build-arg",
      `MISE_SHA256_ARM64=${RUNTIME_MISE_SHA256_ARM64}`,
      "--tag",
      tag,
      ".",
    ],
  };
}

/** Canonicalize only complete local image IDs. */
export function runtimeLocalImageId(value: string): `sha256:${string}` | undefined {
  if (/^sha256:[a-f0-9]{64}$/u.test(value)) return value as `sha256:${string}`;
  return /^[a-f0-9]{64}$/u.test(value) ? (`sha256:${value}` as const) : undefined;
}

async function main(): Promise<void> {
  const plan = runtimeBaseBuildPlan(process.argv.slice(2));
  const build = Bun.spawn([plan.engine, ...plan.args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await build.exited) !== 0) throw new Error("Container base build failed");
  const inspect = Bun.spawn([plan.engine, "image", "inspect", "--format", "{{.Id}}", plan.tag], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });
  const id = runtimeLocalImageId((await new Response(inspect.stdout).text()).trim());
  if ((await inspect.exited) !== 0 || id === undefined)
    throw new Error("Container base build produced no immutable image ID");
  process.stdout.write(`${plan.tag}@${id}\n`);
}

if (import.meta.main) await main();
