import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { prepareRuntimeArtifactVolume } from "../../src/runtime/runtime-artifact-volume.ts";
import type { CachedRuntimeArtifact } from "../../src/runtime/runtime-artifact.ts";
import type { ContainerAttachedProcess, ContainerControl } from "../../src/runtime/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const archiveDigest = `sha256:${"a".repeat(64)}` as const;
const baseImageId = `sha256:${"b".repeat(64)}` as const;
const generation = "00000000-0000-4000-8000-000000000001";
const preparerId = "c".repeat(64);

async function fixture(): Promise<CachedRuntimeArtifact> {
  const root = await mkdtemp(join(tmpdir(), "clarvis-artifact-volume-"));
  roots.push(root);
  const archivePath = join(root, "artifact.tar.gz");
  await writeFile(archivePath, "verified archive bytes");
  return {
    root,
    archivePath,
    entrypoint: "bin/clarvis-kernel",
    manifest: {
      schemaVersion: 1,
      productVersion: "0.0.1-beta",
      sourceRevision: "d".repeat(40),
      dirty: true,
      target: "linux-x64",
      baseAbi: "clarvis-linux-glibc-v1",
      kernelWireVersion: 11,
      brokerVersion: 1,
      channelVersion: 1,
      entrypoint: "bin/clarvis-kernel",
      files: [],
    },
  };
}

const expectedLabels = {
  "io.clarvis.managed": "true",
  "io.clarvis.artifact.schema": "1",
  "io.clarvis.artifact.digest": archiveDigest,
  "io.clarvis.artifact.target": "linux-x64",
  "io.clarvis.artifact.abi": "clarvis-linux-glibc-v1",
};

function attached(exitCode = 0): ContainerAttachedProcess {
  const stdin = new PassThrough();
  stdin.resume();
  const exited = new Promise<number | null>((resolve) =>
    stdin.on("finish", () => resolve(exitCode)),
  );
  return {
    stdin,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exited,
    kill: () => undefined,
  };
}

function control(
  options: {
    exists?: boolean;
    exitCode?: number;
    recoveryExitCode?: number;
    labels?: object;
    engine?: "docker" | "podman";
    consumerId?: string;
  } = {},
) {
  const engine = options.engine ?? "docker";
  const calls: string[][] = [];
  let volumeExists = options.exists === true;
  let preparerRemoved = false;
  let currentMode: "prepare" | "verify" = volumeExists ? "verify" : "prepare";
  let attaches = 0;
  const value: ContainerControl = {
    async run(args) {
      calls.push([...args]);
      if (args[0] === "volume" && args[1] === "inspect") {
        if (!volumeExists) return { exitCode: 1, stdout: "", stderr: "missing" };
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Name: `clarvis-artifact-v1-${archiveDigest.slice(7)}`,
              Labels: options.labels ?? expectedLabels,
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "volume" && args[1] === "create") {
        volumeExists = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "rm") {
        volumeExists = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "volume" && args[1] === "ls")
        return {
          exitCode: 0,
          stdout: volumeExists ? `clarvis-artifact-v1-${archiveDigest.slice(7)}\n` : "",
          stderr: "",
        };
      if (args[0] === "create") {
        preparerRemoved = false;
        currentMode = args.at(-1) === "verify" ? "verify" : "prepare";
        return { exitCode: 0, stdout: preparerId, stderr: "" };
      }
      if (args[0] === "container" && args[1] === "inspect") {
        if (preparerRemoved) return { exitCode: 1, stdout: "", stderr: "missing" };
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Id: preparerId,
              ...(engine === "podman" ? { EffectiveCaps: null, BoundingCaps: null } : {}),
              Config: {
                User: "0:0",
                Entrypoint: ["/usr/local/libexec/clarvis-prepare-artifact"],
                Labels: {
                  "io.clarvis.managed": "true",
                  "io.clarvis.generation": generation,
                  "io.clarvis.role": `artifact-${currentMode}`,
                },
              },
              HostConfig: {
                ReadonlyRootfs: true,
                Privileged: false,
                NetworkMode: "none",
                PidsLimit: 32,
                Memory: 2_147_483_648,
                CapDrop: ["ALL"],
                CapAdd: [],
                SecurityOpt: [engine === "podman" ? "no-new-privileges" : "no-new-privileges=true"],
                Tmpfs: {
                  "/incoming": `rw,nosuid,nodev,noexec,size=805306368${
                    engine === "podman" ? ",rprivate,tmpcopyup" : ""
                  }`,
                },
              },
              Mounts: [
                {
                  Destination: "/artifact",
                  Type: "volume",
                  Name: `clarvis-artifact-v1-${archiveDigest.slice(7)}`,
                  RW: currentMode === "prepare",
                },
              ],
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "container" && args[1] === "ls")
        return { exitCode: 0, stdout: options.consumerId ?? "", stderr: "" };
      if (args[0] === "rm") preparerRemoved = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    attach(args) {
      calls.push([...args]);
      const exitCode = attaches++ === 0 ? options.exitCode : options.recoveryExitCode;
      return attached(exitCode);
    },
  };
  return { value, calls };
}

describe("Container runtime artifact volume", () => {
  test.each([
    ["docker", false, "prepare"],
    ["podman", true, "verify"],
  ] as const)("%s prepares or verifies an immutable cache", async (engine, exists, mode) => {
    const artifact = await fixture();
    const fake = control({ exists, engine });
    await expect(
      prepareRuntimeArtifactVolume({
        control: fake.value,
        engine,
        baseImageId,
        artifact,
        digest: archiveDigest,
        size: 22,
        generation,
      }),
    ).resolves.toEqual({
      name: `clarvis-artifact-v1-${archiveDigest.slice(7)}`,
      subpath: "payload",
    });
    const create = fake.calls.find((args) => args[0] === "create")!;
    expect(create).toContain(`/usr/local/libexec/clarvis-prepare-artifact`);
    expect(create).toContain(mode);
    expect(create.join(" ")).toContain(engine === "docker" ? "volume-nocopy" : ":nocopy");
    expect(fake.calls).toContainEqual(["rm", "--force", preparerId]);
  });

  test("rejects invalid identity and mismatched cache labels before attach", async () => {
    const artifact = await fixture();
    const fake = control({ exists: true, labels: { ...expectedLabels, extra: "value" } });
    await expect(
      prepareRuntimeArtifactVolume({
        control: fake.value,
        engine: "docker",
        baseImageId,
        artifact,
        digest: archiveDigest,
        size: 22,
        generation,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fake.calls.some((args) => args[0] === "start")).toBe(false);
    await expect(
      prepareRuntimeArtifactVolume({
        control: fake.value,
        engine: "docker",
        baseImageId,
        artifact,
        digest: "sha256:short" as `sha256:${string}`,
        size: 22,
        generation,
      }),
    ).rejects.toMatchObject({ code: "invalid_launch_spec" });
  });

  test("fails closed for a corrupt cached payload still mounted by a Container", async () => {
    const artifact = await fixture();
    const fake = control({
      exists: true,
      exitCode: 9,
      engine: "podman",
      consumerId: "e".repeat(64),
    });
    await expect(
      prepareRuntimeArtifactVolume({
        control: fake.value,
        engine: "podman",
        baseImageId,
        artifact,
        digest: archiveDigest,
        size: 22,
        generation,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(fake.calls).toContainEqual(["rm", "--force", preparerId]);
    expect(fake.calls.some((args) => args[0] === "volume" && args[1] === "rm")).toBe(false);
  });

  test("recreates an incomplete cache only after proving it has no consumer", async () => {
    const artifact = await fixture();
    const fake = control({
      exists: true,
      exitCode: 9,
      recoveryExitCode: 0,
      engine: "podman",
    });
    await expect(
      prepareRuntimeArtifactVolume({
        control: fake.value,
        engine: "podman",
        baseImageId,
        artifact,
        digest: archiveDigest,
        size: 22,
        generation,
      }),
    ).resolves.toEqual({
      name: `clarvis-artifact-v1-${archiveDigest.slice(7)}`,
      subpath: "payload",
    });
    expect(fake.calls).toContainEqual([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `volume=clarvis-artifact-v1-${archiveDigest.slice(7)}`,
    ]);
    expect(fake.calls).toContainEqual([
      "volume",
      "rm",
      `clarvis-artifact-v1-${archiveDigest.slice(7)}`,
    ]);
    expect(fake.calls.filter((args) => args[0] === "rm")).toHaveLength(2);
  });

  test("cancels and removes an attached artifact verifier by its inspected id", async () => {
    const artifact = await fixture();
    const fake = control({ exists: true });
    const started = Promise.withResolvers<void>();
    let killed = 0;
    fake.value.attach = (args) => {
      fake.calls.push([...args]);
      started.resolve();
      const streams = attached();
      return {
        ...streams,
        exited: new Promise<number | null>(() => undefined),
        kill: () => {
          killed++;
        },
      };
    };
    const controller = new AbortController();
    const cancelled = new Error("cancelled");
    const running = prepareRuntimeArtifactVolume({
      control: fake.value,
      engine: "docker",
      baseImageId,
      artifact,
      digest: archiveDigest,
      size: 22,
      generation,
      signal: controller.signal,
    });
    await started.promise;
    controller.abort(cancelled);
    await expect(running).rejects.toBe(cancelled);
    expect(killed).toBeGreaterThan(0);
    expect(fake.calls).toContainEqual(["rm", "--force", preparerId]);
  });

  test("refuses malformed inspection and unconfirmed preparer ownership", async () => {
    const artifact = await fixture();
    await expect(
      prepareRuntimeArtifactVolume({
        control: {
          run: async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }),
          attach: () => attached(),
        },
        engine: "docker",
        baseImageId,
        artifact,
        digest: archiveDigest,
        size: 22,
        generation,
      }),
    ).rejects.toThrow("inspection is invalid");
    await expect(
      prepareRuntimeArtifactVolume({
        control: {
          run: async () => ({ exitCode: 0, stdout: "[]", stderr: "" }),
          attach: () => attached(),
        },
        engine: "docker",
        baseImageId,
        artifact,
        digest: archiveDigest,
        size: 22,
        generation,
      }),
    ).rejects.toMatchObject({ code: "conflict" });

    let inspections = 0;
    await expect(
      prepareRuntimeArtifactVolume({
        control: {
          run: async (args) => {
            if (args[0] === "volume") {
              inspections++;
              return {
                exitCode: 0,
                stdout: JSON.stringify([
                  {
                    Name: `clarvis-artifact-v1-${archiveDigest.slice(7)}`,
                    Labels: expectedLabels,
                  },
                ]),
                stderr: "",
              };
            }
            if (args[0] === "container")
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  Id: "short",
                  Config: { Labels: { "io.clarvis.generation": generation } },
                }),
                stderr: "",
              };
            return { exitCode: 0, stdout: "", stderr: "" };
          },
          attach: () => attached(),
        },
        engine: "podman",
        baseImageId,
        artifact,
        digest: archiveDigest,
        size: 22,
        generation,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(inspections).toBeGreaterThan(0);
  });
});
