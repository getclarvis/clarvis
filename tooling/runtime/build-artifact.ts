#!/usr/bin/env bun
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { RUNTIME_BUILD_IMAGE } from "./build-image.ts";

export interface RuntimeArtifactBuildPlan {
  readonly engine: "docker" | "podman";
  readonly target: "linux-x64" | "linux-arm64";
  readonly out: string;
}

function next(args: readonly string[], index: number): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--"))
    throw new Error("missing runtime artifact option value");
  return value;
}

/** Parse the complete artifact builder CLI before invoking an engine. */
export function runtimeArtifactBuildPlan(args: readonly string[]): RuntimeArtifactBuildPlan {
  let engine: RuntimeArtifactBuildPlan["engine"] | undefined;
  let target: RuntimeArtifactBuildPlan["target"] | undefined;
  let out: string | undefined;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = next(args, index);
    if (flag === "--engine" && (value === "docker" || value === "podman")) engine = value;
    else if (flag === "--target" && (value === "linux-x64" || value === "linux-arm64"))
      target = value;
    else if (flag === "--out") out = resolve(value);
    else throw new Error(`invalid runtime artifact build option: ${flag ?? "<missing>"}`);
  }
  if (engine === undefined || target === undefined || out === undefined)
    throw new Error(
      "usage: runtime:artifact:build --engine docker|podman --target linux-x64|linux-arm64 --out directory",
    );
  return { engine, target, out };
}

async function git(root: string, args: readonly string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = (await new Response(child.stdout).text()).trim();
  if ((await child.exited) !== 0) throw new Error("Git source identity failed");
  return output;
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function run(
  argv: readonly string[],
  options: Parameters<typeof Bun.spawn>[1] = {},
): Promise<void> {
  const command = argv[0];
  if (command === undefined) throw new Error("runtime artifact command is empty");
  const child = Bun.spawn([...argv], {
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
    ...options,
  });
  if ((await child.exited) !== 0) throw new Error(`${basename(command)} failed`);
}

async function main(): Promise<void> {
  const plan = runtimeArtifactBuildPlan(process.argv.slice(2));
  const root = await realpath(new URL("../..", import.meta.url).pathname);
  const product = (await Bun.file(join(root, "package.json")).json()) as { version?: unknown };
  if (typeof product.version !== "string") throw new Error("root product version is missing");
  const revision = await git(root, ["rev-parse", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(revision)) throw new Error("source revision is invalid");
  const dirty = (await git(root, ["status", "--porcelain=v1"])).length > 0;
  const info = Bun.spawn(
    plan.engine === "docker"
      ? [plan.engine, "info", "--format", "{{json .Architecture}}"]
      : [plan.engine, "info", "--format", "{{json .Host.Arch}}"],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const architecture = JSON.parse(await new Response(info.stdout).text()) as unknown;
  if (
    (await info.exited) !== 0 ||
    (plan.target === "linux-x64" && architecture !== "x86_64" && architecture !== "amd64") ||
    (plan.target === "linux-arm64" && architecture !== "aarch64" && architecture !== "arm64")
  )
    throw new Error("runtime artifact target does not match the Linux builder engine");
  const staging = await mkdtemp(join(tmpdir(), "clarvis-runtime-artifact-"));
  const payload = join(staging, "payload");
  try {
    await mkdir(join(payload, "bin"), { recursive: true });
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    await run([
      plan.engine,
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,noexec,size=805306368",
      ...(plan.engine === "podman" ? ["--read-only-tmpfs=false"] : []),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      ...(plan.engine === "podman" ? ["--security-opt", "label=disable"] : []),
      "--user",
      `${String(uid)}:${String(gid)}`,
      ...(plan.engine === "podman" ? ["--userns=keep-id"] : []),
      "--workdir",
      "/src",
      "--mount",
      `type=bind,source=${root},target=/src,readonly`,
      "--mount",
      `type=bind,source=${payload},target=/out`,
      "--entrypoint",
      "bun",
      RUNTIME_BUILD_IMAGE,
      "build",
      "tooling/runtime/kernel-entry.ts",
      "--compile",
      "--env=disable",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      "--reject-unresolved",
      "--outfile",
      "/out/bin/clarvis-kernel",
    ]);
    await copyFile(join(root, "LICENSE"), join(payload, "LICENSE"));
    await mkdir(join(payload, "licenses"));
    for (const [source, destination] of [
      ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
      ["third-party/bun/LICENSE.md", "BUN-LICENSE.md"],
      ["third-party/vercel-ai-sdk/LICENSE", "VERCEL-AI-SDK-LICENSE"],
    ] as const)
      await copyFile(join(root, source), join(payload, "licenses", destination));
    await chmod(join(payload, "bin/clarvis-kernel"), 0o555);
    const paths = [
      "LICENSE",
      "bin/clarvis-kernel",
      "licenses/BUN-LICENSE.md",
      "licenses/THIRD_PARTY_NOTICES.md",
      "licenses/VERCEL-AI-SDK-LICENSE",
    ].sort();
    const files = await Promise.all(
      paths.map(async (path) => ({
        path,
        size: (await stat(join(payload, path))).size,
        sha256: await sha256(join(payload, path)),
        executable: path === "bin/clarvis-kernel",
      })),
    );
    const manifest = {
      schemaVersion: 1,
      productVersion: product.version,
      sourceRevision: revision,
      dirty,
      target: plan.target,
      baseAbi: "clarvis-linux-glibc-v1",
      kernelWireVersion: 11,
      brokerVersion: 1,
      channelVersion: 1,
      entrypoint: "bin/clarvis-kernel",
      files,
    } as const;
    await writeFile(join(payload, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await mkdir(plan.out, { recursive: true });
    const archive = join(plan.out, `clarvis-kernel-${plan.target}.tar.gz`);
    await run([
      "tar",
      "--format=ustar",
      "--sort=name",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-czf",
      archive,
      "-C",
      payload,
      "LICENSE",
      "bin",
      "licenses",
      "manifest.json",
    ]);
    const digest = await sha256(archive);
    await writeFile(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
    process.stdout.write(`${archive}\n`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
