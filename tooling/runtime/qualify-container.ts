#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  parseRuntimeArtifactManifest,
  validateRuntimeArtifact,
} from "../../packages/kernel/src/runtime/runtime-artifact.ts";
import { runtimeLocalImageId } from "./build-image.ts";

export interface RuntimeQualificationPlan {
  readonly engine: "docker" | "podman";
  readonly base: string;
  readonly artifact: string;
  readonly report: string;
}

/** Parse every required qualifier input before invoking the selected engine. */
export function runtimeQualificationPlan(args: readonly string[]): RuntimeQualificationPlan {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !["--engine", "--base", "--artifact", "--report"].includes(flag ?? "") ||
      value === undefined ||
      value.startsWith("--")
    )
      throw new Error(`invalid runtime qualification option: ${flag ?? "<missing>"}`);
    if (values.has(flag)) throw new Error(`duplicate runtime qualification option: ${flag}`);
    values.set(flag, value);
  }
  const engine = values.get("--engine");
  const base = values.get("--base");
  const artifact = values.get("--artifact");
  const report = values.get("--report");
  if (
    (engine !== "docker" && engine !== "podman") ||
    base === undefined ||
    artifact === undefined ||
    report === undefined
  )
    throw new Error(
      "usage: runtime:qualify --engine docker|podman --base image --artifact archive --report file",
    );
  return { engine, base, artifact: resolve(artifact), report: resolve(report) };
}

async function capture(argv: readonly string[], maximum = 1024 * 1024): Promise<string> {
  const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const bytes = await new Response(child.stdout).bytes();
  if ((await child.exited) !== 0 || bytes.byteLength > maximum)
    throw new Error("runtime qualification command failed");
  return new TextDecoder().decode(bytes);
}

async function main(): Promise<void> {
  const plan = runtimeQualificationPlan(process.argv.slice(2));
  const archive = await readFile(plan.artifact);
  const archiveDigest = createHash("sha256").update(archive).digest("hex");
  const manifestText = await capture(["tar", "-xOzf", plan.artifact, "manifest.json"]);
  const manifest = parseRuntimeArtifactManifest(new TextEncoder().encode(manifestText));
  const size = (await stat(plan.artifact)).size;
  await validateRuntimeArtifact(plan.artifact, {
    productVersion: manifest.productVersion,
    sourceRevision: manifest.sourceRevision,
    target: manifest.target,
    baseAbi: manifest.baseAbi,
    digest: `sha256:${archiveDigest}`,
    size,
  });
  const inspected = JSON.parse(
    await capture([plan.engine, "image", "inspect", plan.base]),
  ) as unknown;
  const root = Array.isArray(inspected) ? inspected[0] : undefined;
  if (typeof root !== "object" || root === null)
    throw new Error("runtime base inspection is invalid");
  const image = root as {
    Id?: unknown;
    RepoDigests?: unknown;
    Config?: { Labels?: Record<string, unknown> };
  };
  const imageId = runtimeLocalImageId(typeof image.Id === "string" ? image.Id : "");
  if (imageId === undefined || image.Config?.Labels?.["io.clarvis.base.abi"] !== manifest.baseAbi)
    throw new Error("runtime base ABI or image ID is invalid");
  const engineVersion = (
    await capture([
      plan.engine,
      "version",
      "--format",
      plan.engine === "docker" ? "{{.Server.Version}}" : "{{.Version}}",
    ])
  ).trim();
  if (engineVersion.length === 0 || engineVersion.length > 256)
    throw new Error("runtime engine version is invalid");
  const startedAt = Date.now();
  const evidencePath = `${plan.report}.evidence-${process.pid}`;
  await rm(evidencePath, { force: true });
  const test = Bun.spawn(
    [
      "bun",
      "test",
      "packages/kernel/tests/integration/container-kernel.e2e.test.ts",
      "--timeout",
      "600000",
    ],
    {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: {
        PATH: process.env.PATH,
        CLARVIS_RUNTIME_QUALIFY_ENGINE: plan.engine,
        CLARVIS_RUNTIME_QUALIFY_BASE: plan.base,
        CLARVIS_RUNTIME_QUALIFY_ARTIFACT: plan.artifact,
        CLARVIS_RUNTIME_QUALIFY_EVIDENCE: evidencePath,
      },
    },
  );
  const exitCode = await test.exited;
  let executedScenarios: readonly string[] = [];
  try {
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as unknown;
    if (
      typeof evidence !== "object" ||
      evidence === null ||
      !Array.isArray((evidence as { scenarios?: unknown }).scenarios) ||
      !(evidence as { scenarios: unknown[] }).scenarios.every(
        (item): item is string => typeof item === "string",
      )
    )
      throw new Error("Container qualification evidence is invalid");
    executedScenarios = (evidence as { scenarios: string[] }).scenarios;
  } catch (error) {
    if (exitCode === 0)
      throw new Error("Container qualification completed without executed scenario evidence", {
        cause: error,
      });
  } finally {
    await rm(evidencePath, { force: true });
  }
  const requiredScenarios = [
    "compiled-kernel-boot",
    "workspace-bind-and-control-mask",
    "concurrent-writer-refusal",
    "same-namespace-reconnect",
    "autoload-sentinel-refusal",
  ] as const;
  if (exitCode === 0 && requiredScenarios.some((scenario) => !executedScenarios.includes(scenario)))
    throw new Error("Container qualification did not execute every required scenario");
  const report = {
    schema_version: 1,
    source_revision: manifest.sourceRevision,
    base_image_id: imageId,
    base_manifest_digest: Array.isArray(image.RepoDigests)
      ? String(image.RepoDigests[0] ?? "")
          .split("@")
          .at(-1) || null
      : null,
    artifact_sha256: archiveDigest,
    artifact_target: manifest.target,
    base_abi: manifest.baseAbi,
    kernel_wire_version: manifest.kernelWireVersion,
    broker_version: manifest.brokerVersion,
    channel_version: manifest.channelVersion,
    engine: plan.engine,
    engine_version: engineVersion,
    host_platform: `${process.platform}-${process.arch}`,
    guest_platform: manifest.target,
    scenarios: requiredScenarios.map((id) => ({
      id,
      result: exitCode === 0 && executedScenarios.includes(id) ? "pass" : "fail",
    })),
    duration_ms: Date.now() - startedAt,
    cleanup:
      exitCode === 0
        ? "fixture-data-confirmed; content-addressed artifact cache retained"
        : "see-test-output",
  };
  await mkdir(dirname(plan.report), { recursive: true });
  await writeFile(plan.report, `${JSON.stringify(report, null, 2)}\n`);
  if (exitCode !== 0) throw new Error("Container qualification failed");
}

if (import.meta.main) await main();
