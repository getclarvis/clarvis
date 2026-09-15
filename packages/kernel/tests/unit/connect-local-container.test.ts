import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { containerLaunchPaths } from "@clarvis/paths";
import {
  connectLocalContainerKernel,
  connectLocalContainerKernelUsingControl,
  dockerContext,
  engineEnvironment,
  engineTarget,
  preparer,
  prepareMiseVolume,
  verifySharedWorkspace,
} from "../../src/hosting/connect-local-container.ts";
import { runtimeSettingsSchema } from "../../src/runtime/settings.ts";
import { runContainerPreparer } from "../../src/runtime/container-preparer.ts";
import type { ContainerAttachedProcess, ContainerControl } from "../../src/runtime/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const baseImageId = `sha256:${"b".repeat(64)}` as const;
const generation = "00000000-0000-4000-8000-000000000001";
const namespace = "c".repeat(64);
const containerId = "d".repeat(64);

const emptyPreparerPolicy = {
  user: "0:0",
  entrypoint: "/bin/true",
  capabilityAdditions: [] as const,
  pidsLimit: 8,
  memoryBytes: 1024,
  mounts: [] as const,
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

describe("local Container connector preparation", () => {
  test("rejects native and internet-world network placements before engine effects", async () => {
    const base = { workspaceRoot: "/missing", globalDir: "/missing", owner: "fixture" };
    await expect(
      connectLocalContainerKernel({ ...base, runtime: { backend: "native" } as never }),
    ).rejects.toMatchObject({ code: "unsupported" });
    await expect(
      connectLocalContainerKernel({
        ...base,
        runtime: { backend: "podman", network: "internet" },
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  test("engine administration keeps a closed environment and an explicit Docker context", async () => {
    expect(
      engineEnvironment("docker", {
        HOME: "/home/fixture",
        PATH: "/bin",
        DOCKER_CONFIG: "/docker",
        DOCKER_CONTEXT: "desktop-linux",
        TOKEN: "must-not-pass",
      }),
    ).toEqual({
      HOME: "/home/fixture",
      PATH: "/bin",
      DOCKER_CONFIG: "/docker",
      DOCKER_CONTEXT: "desktop-linux",
    });
    expect(
      engineEnvironment("podman", {
        HOME: "/home/fixture",
        PATH: "/bin",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DOCKER_CONFIG: "/must-not-pass",
      }),
    ).toEqual({
      HOME: "/home/fixture",
      PATH: "/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
    });
    await expect(
      dockerContext("/unused/docker", {
        DOCKER_CONTEXT: "  desktop-linux  ",
      }),
    ).resolves.toBe("desktop-linux");
    const root = await mkdtemp(join(tmpdir(), "clarvis-docker-context-"));
    roots.push(root);
    const executable = join(root, "docker");
    await writeFile(executable, "#!/bin/sh\nprintf '%s\\n' fixture-context\n");
    await chmod(executable, 0o755);
    await expect(dockerContext(executable, { PATH: "/bin" })).resolves.toBe("fixture-context");
    await writeFile(executable, "#!/bin/sh\nprintf 'invalid\\ncontext\\n'\n");
    await expect(dockerContext(executable, { PATH: "/bin" })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  test("resolves only admitted Linux engine architectures", async () => {
    const responses = [
      { exitCode: 0, stdout: JSON.stringify({ Architecture: "amd64" }), stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ host: { arch: "aarch64" } }), stderr: "" },
      { exitCode: 1, stdout: "", stderr: "stopped" },
      { exitCode: 0, stdout: "not-json", stderr: "" },
      { exitCode: 0, stdout: JSON.stringify({ Architecture: "riscv64" }), stderr: "" },
    ];
    const control: ContainerControl = {
      run: async () => responses.shift()!,
      attach: () => attached(),
    };
    await expect(engineTarget(control, "docker")).resolves.toBe("linux-x64");
    await expect(engineTarget(control, "podman")).resolves.toBe("linux-arm64");
    await expect(engineTarget(control, "docker")).rejects.toMatchObject({ code: "unavailable" });
    await expect(engineTarget(control, "docker")).rejects.toMatchObject({ code: "unsupported" });
    await expect(engineTarget(control, "docker")).rejects.toMatchObject({ code: "unsupported" });
  });

  test("the ephemeral preparer verifies ownership and removes the exact Container", async () => {
    const calls: string[][] = [];
    let removed = false;
    const control: ContainerControl = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "container" && args[1] === "inspect") {
          if (removed) return { exitCode: 1, stdout: "", stderr: "missing" };
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                Id: containerId,
                Config: {
                  User: "0:0",
                  Entrypoint: ["/bin/true"],
                  Labels: {
                    "io.clarvis.generation": generation,
                    "io.clarvis.state.role": "content",
                    "io.clarvis.base.abi": "clarvis-linux-glibc-v1",
                  },
                },
                HostConfig: {
                  ReadonlyRootfs: true,
                  Privileged: false,
                  NetworkMode: "none",
                  PidsLimit: 8,
                  Memory: 1024,
                  CapDrop: ["ALL"],
                  CapAdd: [],
                  SecurityOpt: ["no-new-privileges=true"],
                  Tmpfs: {},
                },
                Mounts: [],
              },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "container" && args[1] === "ls")
          return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "rm") removed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      attach(args) {
        calls.push([...args]);
        return attached();
      },
    };
    const result = await preparer(control).run({
      labels: {
        "io.clarvis.generation": generation,
        "io.clarvis.state.role": "content",
      },
      createArgs: ["create", "base"],
      policy: emptyPreparerPolicy,
    });
    expect(result.evidence).toEqual({
      containerId,
      labels: {
        "io.clarvis.generation": generation,
        "io.clarvis.state.role": "content",
        "io.clarvis.base.abi": "clarvis-linux-glibc-v1",
      },
      removed: true,
    });
    expect(calls[0]).toEqual(["create", "--name", `clarvis-content-${generation}`, "base"]);
    expect(calls).toContainEqual(["rm", "--force", containerId]);
    await expect(
      preparer(control).run({
        labels: { "io.clarvis.generation": generation },
        createArgs: ["create", "base"],
        policy: emptyPreparerPolicy,
      }),
    ).rejects.toThrow("identity is missing");
    await expect(
      preparer({
        run: async (args) =>
          args[0] === "container"
            ? { exitCode: 1, stdout: "", stderr: "missing" }
            : { exitCode: 0, stdout: "", stderr: "" },
        attach: () => attached(),
      }).run({
        labels: {
          "io.clarvis.generation": generation,
          "io.clarvis.state.role": "state",
        },
        createArgs: ["create", "base"],
        policy: emptyPreparerPolicy,
      }),
    ).rejects.toBeDefined();
  });

  test("the preparer inspects before start and reconciles uncertain create and cancellation", async () => {
    const labels = {
      "io.clarvis.generation": generation,
      "io.clarvis.state.role": "content",
    };
    const inspection = JSON.stringify([
      {
        Id: containerId,
        Config: { User: "0:0", Entrypoint: ["/bin/true"], Labels: labels },
        HostConfig: {
          ReadonlyRootfs: true,
          Privileged: false,
          NetworkMode: "none",
          PidsLimit: 8,
          Memory: 1024,
          CapDrop: ["ALL"],
          CapAdd: [],
          SecurityOpt: ["no-new-privileges=true"],
          Tmpfs: {},
        },
        Mounts: [],
      },
    ]);
    let exists = false;
    let loseCreateResponse = true;
    let killCount = 0;
    const processState: { exitRejection?: Error } = {};
    const calls: string[][] = [];
    const createLost = new Error("create response lost");
    const started = Promise.withResolvers<void>();
    const control: ContainerControl = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "create") {
          exists = true;
          if (loseCreateResponse) throw createLost;
          return { exitCode: 0, stdout: containerId, stderr: "" };
        }
        if (args[0] === "container" && args[1] === "inspect")
          return exists
            ? { exitCode: 0, stdout: inspection, stderr: "" }
            : { exitCode: 1, stdout: "", stderr: "missing" };
        if (args[0] === "container" && args[1] === "ls")
          return { exitCode: 0, stdout: exists ? `${containerId}\n` : "", stderr: "" };
        if (args[0] === "rm") exists = false;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      attach(args) {
        calls.push([...args]);
        started.resolve();
        const streams = attached();
        return {
          ...streams,
          exited:
            processState.exitRejection === undefined
              ? new Promise<number | null>(() => undefined)
              : Promise.reject(processState.exitRejection),
          kill: () => {
            killCount++;
          },
        };
      },
    };
    await expect(
      preparer(control).run({
        labels,
        createArgs: ["create", "base"],
        policy: emptyPreparerPolicy,
      }),
    ).rejects.toBe(createLost);
    expect(calls).toContainEqual(["rm", "--force", containerId]);
    expect(calls.some((call) => call[0] === "start")).toBe(false);

    loseCreateResponse = false;
    const controller = new AbortController();
    const cancelled = new Error("cancelled");
    const running = preparer(control).run({
      labels,
      createArgs: ["create", "base"],
      policy: emptyPreparerPolicy,
      signal: controller.signal,
    });
    await started.promise;
    const inspectIndex = calls.findIndex(
      (call) => call[0] === "container" && call[1] === "inspect",
    );
    const startIndex = calls.findIndex((call) => call[0] === "start");
    expect(inspectIndex).toBeGreaterThan(-1);
    expect(startIndex).toBeGreaterThan(inspectIndex);
    controller.abort(cancelled);
    await expect(running).rejects.toBe(cancelled);
    expect(killCount).toBeGreaterThan(0);
    expect(exists).toBe(false);

    const preCancelled = new AbortController();
    preCancelled.abort("cancelled before start");
    await expect(
      preparer(control).run({
        labels,
        createArgs: ["create", "base"],
        policy: emptyPreparerPolicy,
        signal: preCancelled.signal,
      }),
    ).rejects.toThrow("Container preparer failed");
    expect(exists).toBe(false);

    const processFailure = new Error("process failed");
    processState.exitRejection = processFailure;
    await expect(
      preparer(control).run({
        labels,
        createArgs: ["create", "base"],
        policy: emptyPreparerPolicy,
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(processFailure);
    expect(exists).toBe(false);
  });

  test("the preparer refuses effective-policy and cleanup-identity drift", async () => {
    const labels = {
      "io.clarvis.generation": generation,
      "io.clarvis.state.role": "content",
    };
    const policy = {
      ...emptyPreparerPolicy,
      name: `clarvis-content-${generation}`,
      labels,
    };
    let mode: "policy" | "identity" = "policy";
    let inspections = 0;
    let removed = false;
    const calls: string[][] = [];
    const control: ContainerControl = {
      async run(args) {
        calls.push([...args]);
        if (args[0] === "create") return { exitCode: 0, stdout: containerId, stderr: "" };
        if (args[0] === "container" && args[1] === "inspect") {
          if (removed) return { exitCode: 1, stdout: "", stderr: "missing" };
          inspections++;
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                Id: mode === "identity" && inspections > 1 ? "e".repeat(64) : containerId,
                Config: { User: "0:0", Entrypoint: ["/bin/true"], Labels: labels },
                HostConfig: {
                  ReadonlyRootfs: true,
                  Privileged: mode === "policy",
                  NetworkMode: "none",
                  PidsLimit: 8,
                  Memory: 1024,
                  CapDrop: ["ALL"],
                  CapAdd: [],
                  SecurityOpt: ["no-new-privileges=true"],
                  Tmpfs: {},
                },
                Mounts: [],
              },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "container" && args[1] === "ls")
          return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "rm") removed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      attach: () => attached(),
    };
    await expect(
      runContainerPreparer({ control, createArgs: ["create", "base"], policy }),
    ).rejects.toMatchObject({
      code: "unsupported_policy",
      message: "Container preparer effective policy did not match admission",
    });
    expect(calls).toContainEqual(["rm", "--force", containerId]);

    mode = "identity";
    inspections = 0;
    removed = false;
    await expect(
      runContainerPreparer({ control, createArgs: ["create", "base"], policy }),
    ).rejects.toThrow("cleanup identity changed");
  });

  test("the preparer accepts Podman's exact effective capability projection", async () => {
    const labels = {
      "io.clarvis.generation": generation,
      "io.clarvis.state.role": "content",
    };
    const policy = {
      ...emptyPreparerPolicy,
      name: `clarvis-content-${generation}`,
      labels,
      capabilityAdditions: ["CHOWN"],
    };
    let removed = false;
    const control: ContainerControl = {
      async run(args) {
        if (args[0] === "create") return { exitCode: 0, stdout: containerId, stderr: "" };
        if (args[0] === "container" && args[1] === "inspect") {
          if (removed) return { exitCode: 1, stdout: "", stderr: "missing" };
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                Id: containerId,
                EffectiveCaps: ["CAP_CHOWN"],
                BoundingCaps: ["CAP_CHOWN"],
                Config: { User: "0:0", Entrypoint: ["/bin/true"], Labels: labels },
                HostConfig: {
                  ReadonlyRootfs: true,
                  Privileged: false,
                  NetworkMode: "none",
                  PidsLimit: 8,
                  Memory: 1024,
                  CapDrop: ["CAP_DAC_OVERRIDE", "CAP_SETUID"],
                  CapAdd: [],
                  SecurityOpt: ["no-new-privileges"],
                  Tmpfs: {},
                },
                Mounts: [],
              },
            ]),
            stderr: "",
          };
        }
        if (args[0] === "container" && args[1] === "ls")
          return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "rm") removed = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      attach: () => attached(),
    };
    await expect(
      runContainerPreparer({ control, createArgs: ["create", "base"], policy }),
    ).resolves.toMatchObject({ containerId });
    expect(removed).toBe(true);
  });

  test.each(["docker", "podman"] as const)(
    "%s creates, labels and initializes the namespace mise volume",
    async (engine) => {
      const digest = createHash("sha256")
        .update(JSON.stringify({ schema: 3, namespace, baseImageId }))
        .digest("hex");
      const name = `clarvis-mise-v3-${digest}`;
      let inspections = 0;
      let preparerRemoved = false;
      const calls: string[][] = [];
      const control: ContainerControl = {
        async run(args) {
          calls.push([...args]);
          if (args[0] === "volume" && args[1] === "inspect") {
            if (++inspections === 1) return { exitCode: 1, stdout: "", stderr: "missing" };
            return {
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  Name: name,
                  Labels: {
                    "io.clarvis.runtime.mise-cache": "true",
                    "io.clarvis.runtime.mise-cache.schema": "3",
                    "io.clarvis.runtime.mise-cache.identity": `sha256:${digest}`,
                    "io.clarvis.runtime.mise-cache.base-image": baseImageId,
                  },
                },
              ]),
              stderr: "",
            };
          }
          if (args[0] === "container" && args[1] === "inspect") {
            if (preparerRemoved) return { exitCode: 1, stdout: "", stderr: "missing" };
            return {
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  Id: containerId,
                  Config: {
                    User: "0:0",
                    Entrypoint: ["/bin/sh"],
                    Labels: {
                      "io.clarvis.generation": generation,
                      "io.clarvis.state.role": "mise-preparer",
                    },
                  },
                  HostConfig: {
                    ReadonlyRootfs: true,
                    Privileged: false,
                    NetworkMode: "none",
                    PidsLimit: 16,
                    Memory: 67_108_864,
                    CapDrop: ["ALL"],
                    CapAdd: ["CHOWN"],
                    SecurityOpt: ["no-new-privileges=true"],
                    Tmpfs: {},
                  },
                  Mounts: [{ Destination: "/cache", Type: "volume", Name: name, RW: true }],
                },
              ]),
              stderr: "",
            };
          }
          if (args[0] === "container" && args[1] === "ls")
            return { exitCode: 0, stdout: "", stderr: "" };
          if (args[0] === "rm") {
            preparerRemoved = true;
            return { exitCode: 0, stdout: "", stderr: "" };
          }
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        attach(args) {
          calls.push([...args]);
          return attached();
        },
      };
      await expect(
        prepareMiseVolume({
          control,
          namespace,
          generation,
          baseImageId,
          engine,
          user: { uid: 1000, gid: 1000 },
        }),
      ).resolves.toBe(name);
      const create = calls.find((args) => args[0] === "create")!;
      expect(create).toContain("--cap-add");
      expect(create.join(" ")).toContain(engine === "docker" ? "volume-nocopy" : "userns=keep-id");
    },
  );

  test("rejects a mise volume whose labels do not match its namespace identity", async () => {
    const control: ContainerControl = {
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify([{ Name: "other", Labels: {} }]),
        stderr: "",
      }),
      attach: () => attached(),
    };
    await expect(
      prepareMiseVolume({
        control,
        namespace,
        generation,
        baseImageId,
        engine: "docker",
        user: { uid: 1000, gid: 1000 },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    let calls = 0;
    await expect(
      prepareMiseVolume({
        control: {
          run: async () =>
            ++calls === 1
              ? { exitCode: 1, stdout: "", stderr: "missing" }
              : { exitCode: 1, stdout: "", stderr: "create failed" },
          attach: () => attached(),
        },
        namespace,
        generation,
        baseImageId,
        engine: "docker",
        user: { uid: 1000, gid: 1000 },
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      prepareMiseVolume({
        control: {
          run: async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }),
          attach: () => attached(),
        },
        namespace,
        generation,
        baseImageId,
        engine: "podman",
        user: { uid: 1000, gid: 1000 },
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  test("preflight reads the exact sentinel through the engine and always removes it", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-workspace-preflight-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace with space,unicode-é");
    await mkdir(workspaceRoot);
    const calls: string[][] = [];
    const control: ContainerControl = {
      async run(args, _signal, bounds) {
        calls.push([...args]);
        expect(bounds).toEqual({ timeoutMs: 30_000, maxOutputBytes: 4096 });
        const file = args.at(-1)!.split("/").at(-1)!;
        return {
          exitCode: 0,
          stdout: await readFile(join(workspaceRoot, file), "utf8"),
          stderr: "",
        };
      },
      attach: () => attached(),
    };
    await verifySharedWorkspace({
      control,
      engine: "podman",
      baseImageId,
      workspaceRoot,
      user: { uid: 1000, gid: 1000 },
    });
    expect(await readdir(workspaceRoot)).toEqual([]);
    expect(calls[0]!.join(" ")).toContain("relabel=shared");

    const refused: ContainerControl = {
      run: async () => ({ exitCode: 1, stdout: "", stderr: "denied" }),
      attach: () => attached(),
    };
    await expect(
      verifySharedWorkspace({
        control: refused,
        engine: "docker",
        baseImageId,
        workspaceRoot,
        user: { uid: 1000, gid: 1000 },
      }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  test("orchestration cleans its lease and masks when artifact admission fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-container-orchestration-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    await Promise.all([mkdir(workspaceRoot), mkdir(globalDir)]);
    const control: ContainerControl = {
      async run(args) {
        if (args[0] === "info")
          return {
            exitCode: 0,
            stdout: JSON.stringify({ host: { arch: "amd64" } }),
            stderr: "",
          };
        if (args[0] === "image")
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ Id: baseImageId }]),
            stderr: "",
          };
        if (args[0] === "run") {
          const file = args.at(-1)!.split("/").at(-1)!;
          return {
            exitCode: 0,
            stdout: await readFile(join(workspaceRoot, file), "utf8"),
            stderr: "",
          };
        }
        throw new Error(`unexpected engine call: ${args.join(" ")}`);
      },
      attach: () => attached(),
    };
    const runtime = runtimeSettingsSchema.parse({
      backend: "podman",
      network: "none",
      executable: "/fixture/podman",
      connection: "fixture",
    });
    if (runtime.backend !== "podman") throw new Error("fixture runtime did not parse as Podman");
    const selection = {
      productVersion: "0.0.1-beta",
      sourceRevision: "a".repeat(40),
      target: "linux-x64" as const,
      baseAbi: "clarvis-linux-glibc-v1" as const,
      digest: `sha256:${"e".repeat(64)}` as const,
      size: 1,
    };
    await expect(
      connectLocalContainerKernelUsingControl(
        {
          workspaceRoot,
          globalDir,
          owner: "fixture",
          runtime,
          release: {
            base: { reference: "clarvis-base:local", pull: false },
            artifact: {
              source: { kind: "local", archivePath: join(root, "absent.tar.gz") },
              selection,
            },
          },
          environment: { HOME: root, PATH: process.env.PATH },
          signal: new AbortController().signal,
        },
        runtime,
        control,
      ),
    ).rejects.toBeDefined();
    expect(await readdir(workspaceRoot)).toEqual([]);
  });

  test("requires a release for the exact inspected target", async () => {
    const control: ContainerControl = {
      run: async () => ({
        exitCode: 0,
        stdout: JSON.stringify({ host: { arch: "amd64" } }),
        stderr: "",
      }),
      attach: () => attached(),
    };
    const runtime = runtimeSettingsSchema.parse({ backend: "podman", connection: "fixture" });
    if (runtime.backend !== "podman") throw new Error("fixture runtime did not parse as Podman");
    const base = {
      workspaceRoot: "/unused",
      globalDir: "/unused",
      owner: "fixture",
      runtime,
    };
    await expect(
      connectLocalContainerKernelUsingControl(base, runtime, control),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      connectLocalContainerKernelUsingControl(
        {
          ...base,
          release: {
            base: { reference: "clarvis-base:local", pull: false },
            artifact: {
              source: { kind: "local", archivePath: "/unused" },
              selection: {
                productVersion: "0.0.1-beta",
                sourceRevision: "a".repeat(40),
                target: "linux-arm64",
                baseAbi: "clarvis-linux-glibc-v1",
                digest: `sha256:${"f".repeat(64)}`,
                size: 1,
              },
            },
          },
        },
        runtime,
        control,
      ),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  test("retires an exact registered Kernel only after an explicit ownership decision", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-container-takeover-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    await Promise.all([mkdir(workspaceRoot), mkdir(globalDir)]);
    const paths = containerLaunchPaths(namespace, globalDir);
    await mkdir(paths.root, { recursive: true });
    await writeFile(
      paths.registryFile,
      `${JSON.stringify({
        schema: 1,
        engine: "podman",
        containerId,
        generation,
      })}\n`,
    );
    const runtime = runtimeSettingsSchema.parse({
      backend: "podman",
      network: "none",
      image_digest: baseImageId,
    });
    if (runtime.backend !== "podman") throw new Error("fixture runtime did not parse as Podman");
    const selection = {
      productVersion: "0.0.1-beta",
      sourceRevision: "a".repeat(40),
      target: "linux-x64" as const,
      baseAbi: "clarvis-linux-glibc-v1" as const,
      digest: `sha256:${"e".repeat(64)}` as const,
      size: 1,
    };
    const control: ContainerControl = {
      run: async (args) =>
        args[0] === "info"
          ? {
              exitCode: 0,
              stdout: JSON.stringify({ host: { arch: "amd64" } }),
              stderr: "",
            }
          : {
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  Id: baseImageId.slice("sha256:".length),
                  Config: {
                    Labels: {
                      "io.clarvis.base.abi": "clarvis-linux-glibc-v1",
                      "io.clarvis.base.revision": "f".repeat(64),
                    },
                  },
                },
              ]),
              stderr: "",
            },
      attach: () => attached(),
    };
    let acquireAttempts = 0;
    let terminated = false;
    const marker = new Error("preparation continued");
    await expect(
      connectLocalContainerKernelUsingControl(
        {
          workspaceRoot,
          globalDir,
          owner: "fixture",
          runtime,
          ownershipConflict: "terminate",
          release: {
            base: { reference: "clarvis-base:local", pull: false },
            artifact: {
              source: { kind: "local", archivePath: join(root, "artifact.tar.gz") },
              selection,
            },
          },
          environment: { HOME: root, PATH: "/bin" },
        },
        runtime,
        control,
        {
          resolveVolumeIdentity: async () => ({
            namespace,
            globalRoot: globalDir,
            workspaceRoot,
            projectId: "fixture-project",
          }),
          acquireLease: async (_path, options) => {
            acquireAttempts += 1;
            if (acquireAttempts === 1) {
              expect(options.staleMs).toBe(1_000);
              expect(options.waitMs).toBe(1_000);
              return null;
            }
            expect(options.staleMs).toBe(1_000);
            expect(options.waitMs).toBe(30_000);
            return {
              assertOwned: async () => undefined,
              release: async () => true,
            } as never;
          },
          createBackend: () => ({
            inspect: async () => ({
              available: true,
              engineVersion: "fixture",
              rootless: true,
            }),
            reconcilePrevious: async () => undefined,
            terminatePrevious: async (input) => {
              expect(input).toEqual({ id: containerId, generation, namespace });
              terminated = true;
            },
            startKernel: async () => {
              throw new Error("launch must not start");
            },
          }),
          prepareMounts: async () => {
            throw marker;
          },
        },
      ),
    ).rejects.toBe(marker);
    expect(terminated).toBe(true);
    expect(acquireAttempts).toBe(2);
  });

  test("assembles every admitted preparation result into one immutable launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-container-assembly-"));
    roots.push(root);
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    await Promise.all([mkdir(workspaceRoot), mkdir(globalDir)]);
    const runtime = runtimeSettingsSchema.parse({ backend: "podman", network: "none" });
    if (runtime.backend !== "podman") throw new Error("fixture runtime did not parse as Podman");
    const selection = {
      productVersion: "0.0.1-beta",
      sourceRevision: "a".repeat(40),
      target: "linux-x64" as const,
      baseAbi: "clarvis-linux-glibc-v1" as const,
      digest: `sha256:${"e".repeat(64)}` as const,
      size: 1,
    };
    const artifact = {
      root,
      archivePath: join(root, "artifact.tar.gz"),
      entrypoint: "bin/clarvis-kernel" as const,
      manifest: {
        ...selection,
        schemaVersion: 1 as const,
        dirty: true,
        kernelWireVersion: 11 as const,
        brokerVersion: 1 as const,
        channelVersion: 1 as const,
        entrypoint: "bin/clarvis-kernel" as const,
        files: [],
      },
    };
    const control: ContainerControl = {
      run: async (args) =>
        args[0] === "info"
          ? {
              exitCode: 0,
              stdout: JSON.stringify({ host: { arch: "amd64" } }),
              stderr: "",
            }
          : {
              exitCode: 0,
              stdout: JSON.stringify([
                {
                  Id: baseImageId,
                  Config: {
                    Labels: {
                      "io.clarvis.base.abi": "clarvis-linux-glibc-v1",
                      "io.clarvis.base.revision": "f".repeat(64),
                    },
                  },
                },
              ]),
              stderr: "",
            },
      attach: () => attached(),
    };
    const marker = new Error("launch reached");
    const phases: string[] = [];
    await expect(
      connectLocalContainerKernelUsingControl(
        {
          workspaceRoot,
          globalDir,
          owner: "fixture",
          runtime,
          release: {
            base: { reference: "clarvis-base:local", pull: false },
            artifact: { source: { kind: "local", archivePath: artifact.archivePath }, selection },
          },
          environment: { HOME: root, PATH: "/bin" },
          onProgress: (phase) => phases.push(phase),
        },
        runtime,
        control,
        {
          resolveVolumeIdentity: async () => ({
            namespace,
            globalRoot: globalDir,
            workspaceRoot,
            projectId: "fixture-project",
          }),
          acquireLease: async () =>
            ({ assertOwned: async () => undefined, release: async () => true }) as never,
          prepareMounts: async () => ({
            controlRootMasks: [],
            gitMetadataMounts: [],
            cleanup: async () => undefined,
          }),
          prepareDomainMounts: async () => [
            {
              source: join(workspaceRoot, ".clarvis", "plans"),
              target: "/workspace/.clarvis/plans",
              type: "directory",
              readOnly: false,
            },
          ],
          migrateDomainState: async () => undefined,
          createOperator: () =>
            ({ configStore: {}, models: {}, close: async () => undefined }) as never,
          verifyWorkspace: async () => undefined,
          cacheArtifact: async () => artifact,
          prepareVolumes: async () => ({
            namespace,
            content: { name: "content", subpath: "data", target: "/workspace/.clarvis" },
            state: { name: "state", subpath: "data", target: "/var/lib/clarvis" },
          }),
          prepareArtifactVolume: async () => ({ name: "artifact", subpath: "payload" }),
          projectConfiguration: async () => ({ modelCatalog: [] }) as never,
          prepareMise: async () => "mise",
          launch: async (options) => {
            expect(options.launch).toMatchObject({
              namespace,
              network: "none",
              artifact: { volume: "artifact", digest: selection.digest },
              data: { contentVolume: "content", stateVolume: "state" },
              domainDataMounts: [
                {
                  source: join(workspaceRoot, ".clarvis", "plans"),
                  target: "/workspace/.clarvis/plans",
                  readOnly: false,
                },
              ],
              miseVolume: "mise",
            });
            throw marker;
          },
        },
      ),
    ).rejects.toBe(marker);
    expect(phases).toEqual([
      "inspecting_engine",
      "resolving_runtime",
      "inspecting_workspace",
      "preparing_workspace",
      "preparing_artifact",
      "preparing_state",
      "starting_kernel",
    ]);
  });

  test("the public connector constructs its Podman control before release admission", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-fake-podman-"));
    roots.push(root);
    const executable = join(root, "podman");
    await writeFile(executable, '#!/bin/sh\nprintf \'%s\\n\' \'{"host":{"arch":"amd64"}}\'\n');
    await chmod(executable, 0o755);
    await expect(
      connectLocalContainerKernel({
        workspaceRoot: root,
        globalDir: join(root, "global"),
        owner: "fixture",
        runtime: { backend: "podman", executable, connection: "fixture" },
        environment: { HOME: root, PATH: "/bin" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
});
