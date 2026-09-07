import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import {
  createDockerRuntimeBackend,
  createExecutionPeer,
  RUNTIME_PROTOCOL_REVISION,
  type DockerAttachedProcess,
  type DockerControl,
  type RuntimeLaunchSpec,
} from "../../src/index.ts";

const digest = `sha256:${"d".repeat(64)}`;
const spec: RuntimeLaunchSpec = {
  generation: "docker-1",
  ownerId: "owner",
  project: { id: "project" },
  workspace: {
    id: "workspace",
    projectId: "project",
    label: "feature",
    kind: "external_worktree",
  },
  workspaceRoot: "/work/tree",
  readOnlyWorkspacePaths: ["/work/tree/.clarvis/memory", "/work/tree/.agents/skills"],
  gitCommonDir: "/repo/.git",
  imageDigest: digest,
  configurationRevision: "config",
  extensionRevision: "extensions",
  network: "none",
  limits: {
    cpuCount: 1,
    memoryBytes: 64 * 1024 * 1024,
    processCount: 32,
    outputBytes: 1024,
    storageBytes: 128 * 1024 * 1024,
  },
  capabilityMethods: ["runtime.elicit"],
};

function fixture(
  overrides: {
    image?: string;
    imageAsObject?: boolean;
    privileged?: boolean;
    network?: string;
    protocolRevision?: string;
    guestGeneration?: string;
    guestProtocolRevision?: string;
    miseCacheLabel?: string;
    miseCacheDriver?: string;
    miseCacheMissing?: boolean;
    rmFailures?: number;
    user?: string;
    rootless?: boolean;
    userns?: boolean;
  } = {},
  runtimeSpec: RuntimeLaunchSpec = spec,
) {
  const calls: string[][] = [];
  const kills: NodeJS.Signals[] = [];
  let guest: ReturnType<typeof createExecutionPeer> | undefined;
  let attachedStderr: PassThrough | undefined;
  let resolveExit: ((code: number | null) => void) | undefined;
  let miseCacheName = "";
  let volumeInspections = 0;
  let rmAttempts = 0;
  let user = "";
  const control: DockerControl = {
    async run(args) {
      calls.push([...args]);
      if (args[0] === "info")
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ServerVersion: "29.2.1",
            OSType: "linux",
            SecurityOptions: [
              "name=seccomp",
              ...(overrides.rootless === true ? ["name=rootless"] : []),
              ...(overrides.userns === true ? ["name=userns"] : []),
            ],
          }),
          stderr: "",
        };
      if (args[0] === "image")
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            (() => {
              const inspected = {
                Id: overrides.image ?? runtimeSpec.imageDigest,
                Config: {
                  Labels: {
                    "io.clarvis.runtime.protocol":
                      overrides.protocolRevision ?? RUNTIME_PROTOCOL_REVISION,
                  },
                },
              };
              return overrides.imageAsObject ? inspected : [inspected];
            })(),
          ),
          stderr: "",
        };
      if (args[0] === "volume" && args[1] === "inspect") {
        volumeInspections += 1;
        if (overrides.miseCacheMissing === true && volumeInspections === 1) {
          return { exitCode: 1, stdout: "", stderr: "missing" };
        }
        const name = args[2] ?? "";
        const identity = `sha256:${name.slice("clarvis-mise-v2-".length)}`;
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Name: name,
              Driver: overrides.miseCacheDriver ?? "local",
              Scope: "local",
              Labels: {
                "io.clarvis.runtime.mise-cache": "true",
                "io.clarvis.runtime.mise-cache.schema": "2",
                "io.clarvis.runtime.mise-cache.identity": overrides.miseCacheLabel ?? identity,
              },
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "create") {
        user = args[args.indexOf("--user") + 1] ?? "";
        const cacheMount = args.find((value) => value.includes("target=/mise"));
        miseCacheName = cacheMount?.match(/source=([^,]+)/u)?.[1] ?? "";
      }
      if (args[0] === "rm" && rmAttempts++ < (overrides.rmFailures ?? 0)) {
        return { exitCode: 1, stdout: "", stderr: "busy" };
      }
      if (args[0] === "container")
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              HostConfig: {
                Privileged: overrides.privileged ?? false,
                ReadonlyRootfs: true,
                NetworkMode: overrides.network ?? "none",
                SecurityOpt: ["no-new-privileges=true"],
                CapDrop: ["ALL"],
                PidsLimit: runtimeSpec.limits.processCount,
                Memory: runtimeSpec.limits.memoryBytes,
                Mounts: [{ Target: "/mise", VolumeOptions: { Subpath: "data", NoCopy: true } }],
              },
              Config: {
                User: overrides.user ?? user,
                Labels: { "io.clarvis.generation": runtimeSpec.generation },
              },
              Mounts: [
                {
                  Type: "bind",
                  Source: runtimeSpec.workspaceRoot,
                  Destination: "/workspace",
                  RW: true,
                },
                ...runtimeSpec.readOnlyWorkspacePaths.map((path) => ({
                  Type: "bind",
                  Source: path,
                  Destination: path.replace(runtimeSpec.workspaceRoot, "/workspace"),
                  RW: false,
                })),
                ...(runtimeSpec.gitCommonDir === undefined
                  ? []
                  : [
                      {
                        Type: "bind",
                        Source: runtimeSpec.gitCommonDir,
                        Destination: runtimeSpec.gitCommonDir,
                        RW: true,
                      },
                    ]),
                {
                  Type: "volume",
                  Name: miseCacheName,
                  Destination: "/mise",
                  RW: true,
                },
              ],
            },
          ]),
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    attach(args): DockerAttachedProcess {
      calls.push([...args]);
      const hostToGuest = new PassThrough();
      const guestToHost = new PassThrough();
      const stderr = new PassThrough();
      attachedStderr = stderr;
      const exited = new Promise<number | null>((resolve) => {
        resolveExit = resolve;
      });
      guest = createExecutionPeer({
        role: "guest",
        generation: runtimeSpec.generation,
        input: hostToGuest,
        output: guestToHost,
        handlers: {
          "runtime.bootstrap": async () => ({
            generation: overrides.guestGeneration ?? runtimeSpec.generation,
            imageDigest: runtimeSpec.imageDigest,
            runtimeProtocolRevision:
              overrides.guestProtocolRevision ??
              overrides.protocolRevision ??
              RUNTIME_PROTOCOL_REVISION,
          }),
          "runtime.start": async ({ runId }) => ({ runId }),
          "runtime.steer": async () => undefined,
          "runtime.cancel": async () => undefined,
          "runtime.shutdown": async () => undefined,
        },
      });
      return {
        stdin: hostToGuest,
        stdout: guestToHost,
        stderr,
        exited,
        kill: (signal) => {
          kills.push(signal);
          guest?.close();
        },
      };
    },
  };
  return {
    control,
    calls,
    kills,
    stderr: (value: string) => attachedStderr?.write(value),
    exit: (code: number | null = 0) => resolveExit?.(code),
    close: () => guest?.close(),
  };
}

describe("Docker runtime backend", () => {
  it("selects the operator identity on rootful Linux and partitions its prepared cache by user", async () => {
    const caches: string[] = [];
    for (const uid of [1001, 1002]) {
      const fake = fixture();
      const backend = createDockerRuntimeBackend({
        control: fake.control,
        hostPlatform: "linux",
        hostUser: { uid, gid: 100 },
      });
      await backend.inspect();
      const session = await backend.start(spec);
      const create = fake.calls.find((call) => call[0] === "create")!;
      expect(create[create.indexOf("--user") + 1]).toBe(`${uid}:100`);
      caches.push(create.find((arg) => arg.includes("target=/mise"))!);
      const helper = fake.calls.find((call) => call[0] === "run")!;
      expect(helper).toContain("CHOWN");
      expect(helper).toContain("none");
      expect(helper.some((arg) => arg.includes(spec.workspaceRoot))).toBe(false);
      expect(helper.at(-1)).toBe(`${uid}:100`);
      await session.stop();
      fake.close();
    }
    expect(caches[0]).not.toBe(caches[1]);
  });

  it("maps rootless root to its operator and refuses incompatible effective identities or remapping", async () => {
    const fake = fixture({ rootless: true });
    const backend = createDockerRuntimeBackend({
      control: fake.control,
      hostUser: { uid: 1001, gid: 100 },
    });
    await backend.inspect();
    const session = await backend.start(spec);
    const create = fake.calls.find((call) => call[0] === "create")!;
    expect(create[create.indexOf("--user") + 1]).toBe("0:0");
    await session.stop();
    fake.close();
    const wrong = fixture({ user: "0:0" });
    const mismatch = createDockerRuntimeBackend({
      control: wrong.control,
      hostUser: { uid: 1001, gid: 100 },
    });
    await mismatch.inspect();
    await expect(mismatch.start(spec)).rejects.toMatchObject({ code: "unsupported_policy" });
    expect(wrong.calls.some((call) => call[0] === "start")).toBe(false);
    const remapped = createDockerRuntimeBackend({ control: fixture({ userns: true }).control });
    await expect(remapped.inspect()).resolves.toMatchObject({
      available: false,
      reason: "unsupported_policy",
    });
  });
  it("verifies policy, negotiates the guest and exposes Docker placement", async () => {
    const fake = fixture();
    const backend = createDockerRuntimeBackend({ control: fake.control, hostPlatform: "darwin" });
    await expect(backend.inspect()).resolves.toEqual({
      available: true,
      engineVersion: "29.2.1",
      rootless: false,
    });
    const session = await backend.start(spec);
    expect(session.info).toMatchObject({
      engine: "docker",
      guestPlatform: "linux",
      network: "none",
      runtimeProtocolRevision: RUNTIME_PROTOCOL_REVISION,
    });
    const create = fake.calls.find((call) => call[0] === "create")!;
    expect(create).toContain("--read-only");
    expect(create).toContain("no-new-privileges=true");
    expect(create.find((value) => value.startsWith("/tmp:"))).toContain(
      `size=${spec.limits.storageBytes}`,
    );
    expect(create.find((value) => value.startsWith("/mise:"))).toBeUndefined();
    expect(create).toContainEqual(
      expect.stringMatching(
        /^type=volume,source=clarvis-mise-v2-[a-f0-9]{64},target=\/mise,volume-subpath=data,volume-nocopy$/u,
      ),
    );
    const workspaceMount = create.find((value) => value.includes("target=/workspace"));
    expect(workspaceMount).toBe(`type=bind,source=${spec.workspaceRoot},target=/workspace`);
    expect(create).toContain(
      "type=bind,source=/work/tree/.clarvis/memory,target=/workspace/.clarvis/memory,readonly",
    );
    expect(create).toContain("type=bind,source=/repo/.git,target=/repo/.git");
    const signal = new AbortController().signal;
    await expect(session.startRun("run", {}, signal)).resolves.toEqual({ runId: "run" });
    await expect(session.steer("run", { text: "continue" }, signal)).resolves.toBeUndefined();
    await expect(session.cancel("run")).resolves.toBeUndefined();
    await session.stop();
    await session.stop();
    expect(fake.calls.at(-2)?.slice(0, 3)).toEqual(["stop", "--time", "5"]);
    expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
    expect(fake.calls.some((call) => call[0] === "volume" && call[1] === "rm")).toBe(false);
    fake.close();
  });

  it("fails closed on image, effective policy, internet mode and non-Linux engines", async () => {
    const wrongImage = fixture({ image: `sha256:${"e".repeat(64)}` });
    const imageBackend = createDockerRuntimeBackend({ control: wrongImage.control });
    await imageBackend.inspect();
    await expect(imageBackend.start(spec)).rejects.toMatchObject({ code: "handshake_mismatch" });
    const wrongProtocol = fixture({ protocolRevision: "999" });
    const protocolBackend = createDockerRuntimeBackend({ control: wrongProtocol.control });
    await protocolBackend.inspect();
    await expect(protocolBackend.start(spec)).rejects.toMatchObject({ code: "handshake_mismatch" });
    const privileged = fixture({ privileged: true });
    const policyBackend = createDockerRuntimeBackend({ control: privileged.control });
    await policyBackend.inspect();
    await expect(policyBackend.start(spec)).rejects.toMatchObject({ code: "unsupported_policy" });
    for (const invalidCache of [
      fixture({ miseCacheLabel: `sha256:${"e".repeat(64)}` }),
      fixture({ miseCacheDriver: "remote" }),
    ]) {
      const cacheBackend = createDockerRuntimeBackend({ control: invalidCache.control });
      await cacheBackend.inspect();
      await expect(cacheBackend.start(spec)).rejects.toMatchObject({ code: "unsupported_policy" });
    }
    const internet = fixture();
    const internetBackend = createDockerRuntimeBackend({ control: internet.control });
    await internetBackend.inspect();
    await expect(internetBackend.start({ ...spec, network: "internet" })).rejects.toMatchObject({
      code: "unsupported_policy",
    });
    const nonLinux = createDockerRuntimeBackend({
      control: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ ServerVersion: "29", OSType: "windows" }),
          stderr: "",
        }),
        attach: () => {
          throw new Error("unused");
        },
      },
    });
    await expect(nonLinux.inspect()).resolves.toMatchObject({
      available: false,
      reason: "unsupported_policy",
    });
  });

  it("classifies unavailable engines and requires inspection before launch", async () => {
    const windows = createDockerRuntimeBackend({
      hostPlatform: "win32",
      control: fixture().control,
    });
    await expect(windows.inspect()).resolves.toMatchObject({
      available: false,
      reason: "unsupported_platform",
    });

    const missing = createDockerRuntimeBackend({
      control: {
        run: () => Promise.reject(new Error("spawn failed")),
        attach: () => {
          throw new Error("unused");
        },
      },
    });
    await expect(missing.inspect()).resolves.toMatchObject({
      available: false,
      reason: "engine_missing",
    });

    const stopped = createDockerRuntimeBackend({
      control: {
        run: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "stopped" }),
        attach: () => {
          throw new Error("unused");
        },
      },
    });
    await expect(stopped.inspect()).resolves.toMatchObject({
      available: false,
      reason: "engine_stopped",
    });
    await expect(stopped.start(spec)).rejects.toThrow("inspected before start");
  });

  it("accepts object-shaped image inspection and kills excess guest stderr", async () => {
    const fake = fixture({ imageAsObject: true });
    const backend = createDockerRuntimeBackend({ control: fake.control, stopTimeoutSeconds: 99 });
    await backend.inspect();
    const session = await backend.start({
      ...spec,
      limits: { ...spec.limits, outputBytes: 4 },
    });
    fake.stderr("too much output");
    expect(fake.kills).toContain("SIGKILL");
    await session.stop();
    fake.close();
  });

  it("creates a missing labelled mise cache volume before container admission", async () => {
    const fake = fixture({ miseCacheMissing: true });
    const backend = createDockerRuntimeBackend({ control: fake.control });
    await backend.inspect();
    const session = await backend.start(spec);
    const createVolume = fake.calls.find((call) => call[0] === "volume" && call[1] === "create");
    expect(createVolume).toContain("io.clarvis.runtime.mise-cache=true");
    expect(createVolume).toContain("io.clarvis.runtime.mise-cache.schema=2");
    expect(createVolume).toContainEqual(
      expect.stringMatching(/^io\.clarvis\.runtime\.mise-cache\.identity=sha256:[a-f0-9]{64}$/u),
    );
    await session.stop();
    fake.close();
  });

  it("separates the mise cache by owner, project, workspace and exact image", async () => {
    const variants: RuntimeLaunchSpec[] = [
      spec,
      { ...spec, generation: "docker-owner", ownerId: "other-owner" },
      {
        ...spec,
        generation: "docker-project",
        project: { id: "other-project" },
        workspace: { ...spec.workspace, projectId: "other-project" },
      },
      {
        ...spec,
        generation: "docker-workspace",
        workspace: { ...spec.workspace, id: "other-workspace" },
      },
      {
        ...spec,
        generation: "docker-image",
        imageDigest: `sha256:${"e".repeat(64)}`,
      },
    ];
    const names: string[] = [];
    for (const variant of variants) {
      const fake = fixture({}, variant);
      const backend = createDockerRuntimeBackend({ control: fake.control });
      await backend.inspect();
      const session = await backend.start(variant);
      const cacheInspect = fake.calls.find((call) => call[0] === "volume" && call[1] === "inspect");
      names.push(cacheInspect?.[2] ?? "");
      await session.stop();
      fake.close();
    }
    expect(names.every((name) => /^clarvis-mise-v2-[a-f0-9]{64}$/u.test(name))).toBe(true);
    expect(new Set(names).size).toBe(variants.length);
  });

  it("marks the session closed when the attached Docker process exits", async () => {
    const fake = fixture();
    const backend = createDockerRuntimeBackend({ control: fake.control });
    await backend.inspect();
    const session = await backend.start(spec);
    expect(session.closed).toBe(false);
    fake.exit(0);
    await Bun.sleep(0);
    expect(session.closed).toBe(true);
    await expect(session.startRun("after-exit", {})).rejects.toMatchObject({
      code: "unavailable",
    });
    await session.stop();
    fake.close();
  });

  it("retries container removal without repeating guest shutdown", async () => {
    const fake = fixture({ rmFailures: 1 });
    const backend = createDockerRuntimeBackend({ control: fake.control });
    await backend.inspect();
    const session = await backend.start(spec);
    await expect(session.stop()).rejects.toThrow("docker rm failed");
    expect(session.closed).toBe(true);
    await expect(session.stop()).resolves.toBeUndefined();
    expect(fake.calls.filter((call) => call[0] === "stop")).toHaveLength(1);
    expect(fake.calls.filter((call) => call[0] === "rm")).toHaveLength(2);
    fake.close();
  });

  it("fails closed when the live guest identity differs from the admitted image", async () => {
    for (const fake of [
      fixture({ guestGeneration: "other-generation" }),
      fixture({ guestProtocolRevision: "other-revision" }),
    ]) {
      const backend = createDockerRuntimeBackend({ control: fake.control });
      await backend.inspect();
      await expect(backend.start(spec)).rejects.toMatchObject({ code: "handshake_mismatch" });
      expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
      fake.close();
    }
  });

  it("rejects malformed Docker JSON rather than trusting partial inspection", async () => {
    const backend = createDockerRuntimeBackend({
      control: {
        run: () => Promise.resolve({ exitCode: 0, stdout: "not-json", stderr: "" }),
        attach: () => {
          throw new Error("unused");
        },
      },
    });
    await expect(backend.inspect()).rejects.toMatchObject({ code: "operational_failure" });
  });
});
