import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { randomUUID } from "node:crypto";
import { createContainerKernelBackend } from "../../src/runtime/container-kernel-backend.ts";
import { createDockerKernelBackend } from "../../src/runtime/docker-backend.ts";
import { createPodmanKernelBackend } from "../../src/runtime/podman-backend.ts";
import type {
  ContainerAttachedProcess,
  ContainerControl,
  ContainerKernelLaunchSpec,
} from "../../src/runtime/types.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const id = "a".repeat(64);
const imageId = "b".repeat(64);
const namespace = "c".repeat(64);
const environment = [
  "PATH=/mise/shims:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "HOME=/var/lib/clarvis/home",
  "TMPDIR=/tmp",
  "LANG=C.UTF-8",
  "LC_ALL=C.UTF-8",
  "TZ=UTC",
  "MISE_QUIET=1",
  "MISE_DATA_DIR=/mise",
  "MISE_CACHE_DIR=/mise/cache",
  "MISE_CONFIG_DIR=/mise/config",
  "MISE_STATE_DIR=/mise/state",
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clarvis-container-backend-"));
  roots.push(root);
  const workspaceRoot = join(root, "workspace");
  const mask = join(root, "mask");
  const git = join(root, "git-file");
  await mkdir(workspaceRoot);
  await mkdir(mask);
  await writeFile(git, "gitdir");
  const spec: ContainerKernelLaunchSpec = {
    generation: randomUUID(),
    namespace,
    workspaceRoot,
    controlRootMasks: [
      { source: mask, target: "/workspace/.agents", type: "directory", readOnly: true },
    ],
    gitMetadataMounts: [{ source: git, target: "/workspace/.git", type: "file", readOnly: true }],
    baseImageId: `sha256:${imageId}`,
    baseAbi: "clarvis-linux-glibc-v1",
    artifact: {
      volume: "clarvis-artifact-v1-fixture",
      digest: `sha256:${"d".repeat(64)}`,
      target: "linux-x64",
    },
    data: { contentVolume: "content", stateVolume: "state" },
    miseVolume: "mise",
    network: "outbound",
    limits: {
      cpuCount: 2,
      memoryBytes: 1024,
      processCount: 32,
      outputBytes: 4096,
      storageBytes: 8192,
    },
    user: { uid: 1000, gid: 1000 },
  };
  return { root, spec };
}

function attached(): ContainerAttachedProcess {
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exited: Promise.resolve(0),
    kill: () => undefined,
  };
}

function inspectValue(spec: ContainerKernelLaunchSpec, engine: "docker" | "podman") {
  return [
    {
      Id: id,
      Config: {
        Labels: {
          "io.clarvis.managed": "true",
          "io.clarvis.role": "kernel",
          "io.clarvis.generation": spec.generation,
          "io.clarvis.state.namespace": spec.namespace,
        },
        User: "1000:1000",
        WorkingDir: "/workspace",
        Entrypoint: ["/opt/clarvis/bin/clarvis-kernel"],
        Env: environment,
      },
      HostConfig: {
        ReadonlyRootfs: true,
        Privileged: false,
        PidsLimit: 32,
        Memory: 1024,
        NanoCpus: 2_000_000_000,
        NetworkMode: "bridge",
        CapDrop: engine === "docker" ? ["ALL"] : ["audit_write", "chown"],
        CapAdd: [],
        SecurityOpt: ["no-new-privileges=true"],
        Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=8192" },
      },
      Mounts: [
        { Destination: "/workspace", Type: "bind", Source: spec.workspaceRoot, RW: true },
        {
          Destination: "/workspace/.clarvis",
          Type: "volume",
          Name: spec.data.contentVolume,
          RW: true,
        },
        {
          Destination: "/var/lib/clarvis",
          Type: "volume",
          Name: spec.data.stateVolume,
          RW: true,
        },
        {
          Destination: "/opt/clarvis",
          Type: "volume",
          Name: spec.artifact.volume,
          RW: false,
        },
        { Destination: "/mise", Type: "volume", Name: spec.miseVolume, RW: true },
        {
          Destination: "/workspace/.agents",
          Type: "bind",
          Source: spec.controlRootMasks[0]!.source,
          RW: false,
        },
        {
          Destination: "/workspace/.git",
          Type: "bind",
          Source: spec.gitMetadataMounts[0]!.source,
          RW: false,
        },
      ],
    },
  ];
}

describe("complete Container Kernel backend", () => {
  test.each(["docker", "podman"] as const)(
    "%s inspects, launches with fixed policy, and owns exact cleanup",
    async (engine) => {
      const { spec } = await fixture();
      const calls: string[][] = [];
      const process = attached();
      const control: ContainerControl = {
        run: async (args) => {
          calls.push([...args]);
          if (args[0] === "info")
            return {
              exitCode: 0,
              stdout:
                engine === "docker"
                  ? JSON.stringify({ ServerVersion: "1", OSType: "linux" })
                  : JSON.stringify({ version: { Version: "1" }, host: { os: "linux" } }),
              stderr: "",
            };
          if (args[0] === "image")
            return {
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  Id: imageId,
                  Config: {
                    Labels: {
                      "io.clarvis.base.abi": "clarvis-linux-glibc-v1",
                      "io.clarvis.base.revision": "fixture",
                    },
                  },
                },
              ]),
              stderr: "",
            };
          if (args[0] === "create") return { exitCode: 0, stdout: id, stderr: "" };
          if (args[0] === "container")
            return { exitCode: 0, stdout: JSON.stringify(inspectValue(spec, engine)), stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        attach: (args) => {
          calls.push([...args]);
          return process;
        },
      };
      const backend =
        engine === "docker"
          ? createDockerKernelBackend({ control })
          : createPodmanKernelBackend({ control });
      expect(await backend.inspect()).toEqual({
        available: true,
        engineVersion: "1",
        rootless: engine === "podman",
      });
      const lifecycle = await backend.startKernel(spec);
      expect(lifecycle.id).toBe(id);
      const create = calls.find((args) => args[0] === "create")!;
      expect(create).toContain("--read-only");
      expect(create).toContain("no-new-privileges=true");
      expect(create).not.toContain("internet");
      expect(create.join(" ")).not.toContain("TOKEN");
      if (engine === "podman") expect(create).toContain("--unsetenv-all");
      await lifecycle.stop(10);
      await lifecycle.remove();
      await lifecycle.remove();
      expect(calls).toContainEqual(["stop", "--time", "10", id]);
      expect(calls.filter((args) => args[0] === "rm")).toEqual([["rm", "--force", id]]);
    },
  );

  test("fails closed before create for unavailable, uninspected, invalid and mismatched inputs", async () => {
    const { spec } = await fixture();
    const outputs = [
      { exitCode: 1, stdout: "", stderr: "stopped" },
      { exitCode: 0, stdout: "not json", stderr: "" },
      {
        exitCode: 0,
        stdout: JSON.stringify({ ServerVersion: "1", OSType: "windows" }),
        stderr: "",
      },
    ];
    const control: ContainerControl = {
      run: async () => outputs.shift() ?? { exitCode: 1, stdout: "", stderr: "missing" },
      attach: () => attached(),
    };
    const backend = createContainerKernelBackend({ engine: "docker", control });
    expect(await backend.inspect()).toMatchObject({ available: false, reason: "engine_stopped" });
    expect(await backend.inspect()).toMatchObject({ available: false, reason: "engine_missing" });
    expect(await backend.inspect()).toMatchObject({
      available: false,
      reason: "unsupported_policy",
    });
    await expect(backend.startKernel(spec)).rejects.toMatchObject({ code: "operational_failure" });

    const invalid = { ...spec, generation: "invalid" };
    const ready = createContainerKernelBackend({
      engine: "docker",
      control: {
        run: async (args) =>
          args[0] === "info"
            ? {
                exitCode: 0,
                stdout: JSON.stringify({ ServerVersion: "1", OSType: "linux" }),
                stderr: "",
              }
            : { exitCode: 1, stdout: "", stderr: "missing" },
        attach: () => attached(),
      },
    });
    await ready.inspect();
    await expect(ready.startKernel(invalid)).rejects.toMatchObject({ code: "invalid_launch_spec" });
    await expect(ready.startKernel(spec)).rejects.toMatchObject({ code: "operational_failure" });
  });

  test("reconciliation removes only a stopped Container with exact ownership", async () => {
    const generation = randomUUID();
    const calls: string[][] = [];
    let running = false;
    let owned = true;
    let removeFails = false;
    const control: ContainerControl = {
      run: async (args) => {
        calls.push([...args]);
        if (args[0] === "container")
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                Id: id,
                Config: {
                  Labels: {
                    "io.clarvis.managed": owned ? "true" : "false",
                    "io.clarvis.role": "kernel",
                    "io.clarvis.generation": generation,
                    "io.clarvis.state.namespace": namespace,
                  },
                },
                State: { Running: running },
              },
            ]),
            stderr: "",
          };
        return removeFails
          ? { exitCode: 1, stdout: "", stderr: "refused" }
          : { exitCode: 0, stdout: "", stderr: "" };
      },
      attach: () => attached(),
    };
    const backend = createContainerKernelBackend({ engine: "podman", control });
    await backend.reconcilePrevious({ id, generation, namespace });
    expect(calls.at(-1)).toEqual(["rm", id]);
    running = true;
    await expect(backend.reconcilePrevious({ id, generation, namespace })).rejects.toThrow(
      "still running",
    );
    running = false;
    owned = false;
    await expect(backend.reconcilePrevious({ id, generation, namespace })).rejects.toThrow(
      "ownership is unconfirmed",
    );
    owned = true;
    removeFails = true;
    await expect(backend.reconcilePrevious({ id, generation, namespace })).rejects.toThrow(
      "cleanup is unconfirmed",
    );
    await expect(
      backend.reconcilePrevious({ id: "short", generation, namespace }),
    ).rejects.toMatchObject({ code: "invalid_launch_spec" });
  });

  test("sanitizes create failure and cleans a created ID when effective policy drifts", async () => {
    const { spec } = await fixture();
    let createFails = true;
    const calls: string[][] = [];
    const control: ContainerControl = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "info")
          return {
            exitCode: 0,
            stdout: JSON.stringify({ ServerVersion: "1", OSType: "linux" }),
            stderr: "",
          };
        if (args[0] === "image")
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                Id: imageId,
                Config: {
                  Labels: {
                    "io.clarvis.base.abi": "clarvis-linux-glibc-v1",
                    "io.clarvis.base.revision": "fixture",
                  },
                },
              },
            ]),
            stderr: "",
          };
        if (args[0] === "create")
          return createFails
            ? { exitCode: 1, stdout: "", stderr: "\u001b[31msecret\tcreate\nfailed\u001b[0m" }
            : { exitCode: 0, stdout: id, stderr: "" };
        if (args[0] === "container")
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                ...inspectValue(spec, "docker")[0],
                Id: id,
                HostConfig: {
                  ...inspectValue(spec, "docker")[0]!.HostConfig,
                  Privileged: true,
                },
              },
            ]),
            stderr: "",
          };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      attach: () => attached(),
    };
    const backend = createDockerKernelBackend({ control });
    await backend.inspect();
    await expect(backend.startKernel(spec)).rejects.toThrow("create failed");
    createFails = false;
    await expect(backend.startKernel(spec)).rejects.toMatchObject({ code: "unsupported_policy" });
    expect(calls).toContainEqual(["rm", "--force", id]);
  });
});
