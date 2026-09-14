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
      kernelWireVersion: 10,
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

function control(options: { exists?: boolean; exitCode?: number; labels?: object } = {}) {
  const calls: string[][] = [];
  let volumeInspections = 0;
  const process = attached(options.exitCode);
  const value: ContainerControl = {
    async run(args) {
      calls.push([...args]);
      if (args[0] === "volume" && args[1] === "inspect") {
        volumeInspections++;
        if (!options.exists && volumeInspections === 1)
          return { exitCode: 1, stdout: "", stderr: "missing" };
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
      if (args[0] === "container" && args[1] === "inspect")
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            { Id: preparerId, Config: { Labels: { "io.clarvis.generation": generation } } },
          ]),
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    attach(args) {
      calls.push([...args]);
      return process;
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
    const fake = control({ exists });
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

  test("fails closed for a corrupt cached payload and still removes its exact preparer", async () => {
    const artifact = await fixture();
    const fake = control({ exists: true, exitCode: 9 });
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
