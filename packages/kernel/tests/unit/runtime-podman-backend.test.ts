import { PassThrough } from "node:stream";
import { describe, expect, it } from "bun:test";
import {
  createExecutionPeer,
  createPodmanRuntimeBackend,
  RUNTIME_PROTOCOL_REVISION,
  type PodmanAttachedProcess,
  type PodmanControl,
  type RuntimeLaunchSpec,
} from "../../src/index.ts";

import { miseCacheIdentity } from "../../src/runtime/container-mise-cache.ts";

const digest = `sha256:${"b".repeat(64)}`;
const spec: RuntimeLaunchSpec = {
  generation: "runtime-1",
  ownerId: "owner-1",
  project: { id: "project-1" },
  workspace: {
    id: "workspace-1",
    projectId: "project-1",
    label: "feature",
    kind: "external_worktree",
  },
  workspaceRoot: "/work/tree",
  readOnlyWorkspacePaths: ["/work/tree/.clarvis/memory"],
  gitCommonDir: "/repo/.git",
  imageDigest: digest,
  configurationRevision: "config-1",
  extensionRevision: "extensions-1",
  network: "none",
  limits: {
    cpuCount: 1,
    memoryBytes: 1024 * 1024,
    processCount: 10,
    outputBytes: 1024,
    storageBytes: 2 * 1024 * 1024,
  },
  capabilityMethods: ["memory.search"],
};

function fakeControl(
  overrides: {
    readonly privileged?: boolean;
    readonly imageDigest?: string;
    readonly handshakeDigest?: string;
    readonly protocolRevision?: string;
    readonly rmFailures?: number;
    readonly effective?: (value: Record<string, unknown>) => void;
  } = {},
) {
  const calls: readonly string[][] & string[][] = [];
  const cache = miseCacheIdentity(spec, "0:0");
  let guest: ReturnType<typeof createExecutionPeer> | undefined;
  let resolveExit: ((code: number | null) => void) | undefined;
  let rmAttempts = 0;
  const control: PodmanControl = {
    async run(args) {
      calls.push([...args]);
      if (args[0] === "info") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            version: { Version: "5.4.0" },
            host: { security: { rootless: true } },
          }),
          stderr: "",
        };
      }
      if (args[0] === "image") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Id: overrides.imageDigest ?? digest,
              Digest: `sha256:${"e".repeat(64)}`,
              Config: {
                Labels: {
                  "io.clarvis.runtime.protocol":
                    overrides.protocolRevision ?? RUNTIME_PROTOCOL_REVISION,
                },
              },
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "volume") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              Name: cache.name,
              Driver: "local",
              Labels: {
                "io.clarvis.runtime.mise-cache": "true",
                "io.clarvis.runtime.mise-cache.schema": "2",
                "io.clarvis.runtime.mise-cache.identity": cache.digest,
              },
            },
          ]),
          stderr: "",
        };
      }
      if (args[0] === "container") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            (() => {
              const value = {
                EffectiveCaps: null,
                BoundingCaps: null,
                HostConfig: {
                  Privileged: overrides.privileged ?? false,
                  NetworkMode: "none",
                  UsernsMode: "",
                  ReadonlyRootfs: true,
                  Memory: spec.limits.memoryBytes,
                  PidsLimit: spec.limits.processCount,
                  NanoCpus: spec.limits.cpuCount * 1_000_000_000,
                  SecurityOpt: ["no-new-privileges"],
                  Tmpfs: { "/tmp": `rw,nosuid,nodev,noexec,size=${spec.limits.storageBytes}` },
                },
                Config: { User: "0:0", Labels: { "io.clarvis.generation": spec.generation } },
                Mounts: [
                  {
                    Type: "volume",
                    Name: cache.name,
                    Destination: "/mise",
                    RW: true,
                    SubPath: "data",
                  },
                  {
                    Type: "bind",
                    Source: spec.workspaceRoot,
                    Destination: "/workspace",
                    RW: true,
                  },
                  {
                    Type: "bind",
                    Source: spec.readOnlyWorkspacePaths[0],
                    Destination: "/workspace/.clarvis/memory",
                    RW: false,
                  },
                  {
                    Type: "bind",
                    Source: spec.gitCommonDir,
                    Destination: spec.gitCommonDir,
                    RW: true,
                  },
                ],
              };
              overrides.effective?.(value);
              return value;
            })(),
          ]),
          stderr: "",
        };
      }
      if (args[0] === "rm" && rmAttempts++ < (overrides.rmFailures ?? 0)) {
        return { exitCode: 1, stdout: "", stderr: "busy" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    attach(args): PodmanAttachedProcess {
      calls.push([...args]);
      const hostToGuest = new PassThrough();
      const guestToHost = new PassThrough();
      const stderr = new PassThrough();
      const exited = new Promise<number | null>((resolve) => {
        resolveExit = resolve;
      });
      guest = createExecutionPeer({
        role: "guest",
        generation: spec.generation,
        input: hostToGuest,
        output: guestToHost,
        handlers: {
          "runtime.bootstrap": async () => ({
            generation: spec.generation,
            imageDigest: overrides.handshakeDigest ?? digest,
            runtimeProtocolRevision: overrides.protocolRevision ?? RUNTIME_PROTOCOL_REVISION,
          }),
          "runtime.start": async ({ runId }) => ({ runId, status: "done" }),
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
        kill: () => guest?.close(),
      };
    },
  };
  return {
    control,
    calls,
    exit: (code: number | null = 0) => resolveExit?.(code),
    close: () => guest?.close(),
  };
}

describe("Podman runtime backend", () => {
  it.each([
    ["ReadonlyRootfs", false],
    ["Memory", spec.limits.memoryBytes * 2],
    ["PidsLimit", 0],
    ["NanoCpus", 0],
    ["NetworkMode", "host"],
    ["UsernsMode", "keep-id"],
    ["SecurityOpt", []],
    ["Tmpfs", { "/tmp": "rw,exec,size=99999999" }],
    [
      "Tmpfs",
      { "/tmp": `rw,nosuid,nodev,noexec,size=${spec.limits.storageBytes}`, "/extra": "rw" },
    ],
  ])("refuses effective HostConfig.%s drift before attachment", async (field, value) => {
    const fake = fakeControl({
      effective: (inspection) => {
        (inspection.HostConfig as Record<string, unknown>)[field as string] = value;
      },
    });
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await backend.inspect();
    await expect(backend.start(spec)).rejects.toMatchObject({ code: "unsupported_policy" });
    expect(fake.calls.some((args) => args[0] === "start")).toBe(false);
    expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it.each(["EffectiveCaps", "BoundingCaps"])("rejects widened or missing %s", async (field) => {
    for (const value of [["CAP_SYS_ADMIN"], undefined]) {
      const fake = fakeControl({
        effective: (inspection) => {
          inspection[field] = value;
        },
      });
      const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
      await backend.inspect();
      await expect(backend.start(spec)).rejects.toMatchObject({ code: "unsupported_policy" });
      expect(fake.calls.some((args) => args[0] === "start")).toBe(false);
    }
  });

  it("rejects a widened cache mount that would expose its initialization marker", async () => {
    const fake = fakeControl({
      effective: (inspection) => {
        const mounts = inspection.Mounts as Array<Record<string, unknown>>;
        mounts[0]!.SubPath = "";
      },
    });
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await backend.inspect();
    await expect(backend.start(spec)).rejects.toMatchObject({ code: "unsupported_policy" });
    expect(fake.calls.some((args) => args[0] === "start")).toBe(false);
  });

  it("accepts the full unprefixed local image ID returned by Podman", async () => {
    const fake = fakeControl({ imageDigest: digest.slice("sha256:".length) });
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await backend.inspect();
    const session = await backend.start(spec);
    expect(session.info.imageDigest).toBe(digest);
    await session.stop();
    fake.close();
  });

  it.each(["b".repeat(12), "B".repeat(64), `sha512:${"b".repeat(64)}`, "latest"])(
    "refuses noncanonical image identity %s",
    async (imageDigest) => {
      const fake = fakeControl({ imageDigest });
      const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
      await backend.inspect();
      await expect(backend.start(spec)).rejects.toMatchObject({ code: "handshake_mismatch" });
      expect(fake.calls.map((args) => args[0])).toEqual(["info", "image"]);
    },
  );
  it("admits the local image ID even when its manifest digest differs, then negotiates a session", async () => {
    const fake = fakeControl();
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await expect(backend.inspect()).resolves.toEqual({
      available: true,
      engineVersion: "5.4.0",
      rootless: true,
    });
    const session = await backend.start(spec);
    expect(fake.calls.map((args) => args[0])).toEqual([
      "info",
      "image",
      "volume",
      "run",
      "create",
      "container",
      "start",
    ]);
    expect(fake.calls.find((args) => args[0] === "create")).toContain("ALL");
    expect(fake.calls.find((args) => args[0] === "create")).toContain("no-new-privileges");
    expect(fake.calls.find((args) => args[0] === "create")).toContain("--read-only");
    expect(fake.calls.find((args) => args[0] === "create")).not.toContain("--storage-opt");
    expect(fake.calls.find((args) => args[0] === "create")).toContain(
      `type=bind,source=${spec.workspaceRoot},target=/workspace,rw=true,relabel=shared`,
    );
    expect(fake.calls.find((args) => args[0] === "create")).toContain(
      "type=bind,source=/work/tree/.clarvis/memory,target=/workspace/.clarvis/memory,ro=true,relabel=shared",
    );
    expect(fake.calls.find((args) => args[0] === "create")).toContain(
      "type=bind,source=/repo/.git,target=/repo/.git,rw=true,relabel=shared",
    );
    await expect(session.startRun("run-1", {})).resolves.toEqual({
      runId: "run-1",
      status: "done",
    });
    await session.steer("run-1", { message: "next" });
    await session.cancel("run-1");
    await session.stop();
    await session.stop();
    expect(fake.calls.at(-2)?.slice(0, 3)).toEqual(["stop", "--time", "5"]);
    expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
    fake.close();
  });

  it("refuses an image built for another private runtime protocol", async () => {
    const fake = fakeControl({ protocolRevision: "999" });
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await backend.inspect();
    await expect(backend.start(spec)).rejects.toMatchObject({ code: "handshake_mismatch" });
    expect(fake.calls.map((args) => args[0])).toEqual(["info", "image"]);
  });

  it("marks the session closed when the attached Podman process exits", async () => {
    const fake = fakeControl();
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await backend.inspect();
    const session = await backend.start(spec);
    expect(session.closed).toBe(false);
    fake.exit(137);
    await Bun.sleep(0);
    expect(session.closed).toBe(true);
    await expect(session.startRun("after-exit", {})).rejects.toMatchObject({
      code: "unavailable",
    });
    await session.stop();
    fake.close();
  });

  it("retries container removal without repeating guest shutdown", async () => {
    const fake = fakeControl({ rmFailures: 1 });
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await backend.inspect();
    const session = await backend.start(spec);
    await expect(session.stop()).rejects.toThrow("podman rm failed");
    expect(session.closed).toBe(true);
    await expect(session.stop()).resolves.toBeUndefined();
    expect(fake.calls.filter((call) => call[0] === "stop")).toHaveLength(1);
    expect(fake.calls.filter((call) => call[0] === "rm")).toHaveLength(2);
    fake.close();
  });

  it("refuses a mutable or mismatched image before creating a container", async () => {
    const fake = fakeControl({ imageDigest: `sha256:${"c".repeat(64)}` });
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await backend.inspect();
    await expect(backend.start(spec)).rejects.toMatchObject({ code: "handshake_mismatch" });
    expect(fake.calls.map((args) => args[0])).toEqual(["info", "image"]);
  });

  it("refuses internet mode until external egress enforcement exists", async () => {
    const fake = fakeControl();
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await backend.inspect();
    await expect(backend.start({ ...spec, network: "internet" })).rejects.toMatchObject({
      code: "unsupported_policy",
    });
    expect(fake.calls.some((args) => args[0] === "start")).toBe(false);
  });

  it("removes a never-started container when effective policy differs", async () => {
    const fake = fakeControl({ privileged: true });
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await backend.inspect();
    await expect(backend.start(spec)).rejects.toMatchObject({ code: "unsupported_policy" });
    expect(fake.calls.some((args) => args[0] === "start")).toBe(false);
    expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("kills and removes a container whose guest identity mismatches", async () => {
    const fake = fakeControl({ handshakeDigest: `sha256:${"c".repeat(64)}` });
    const backend = createPodmanRuntimeBackend({ control: fake.control, hostPlatform: "linux" });
    await backend.inspect();
    await expect(backend.start(spec)).rejects.toMatchObject({ code: "handshake_mismatch" });
    expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
  });

  it("reports missing, stopped, non-rootless and unsupported platform distinctly", async () => {
    const missing = createPodmanRuntimeBackend({
      hostPlatform: "linux",
      control: {
        run: async () => Promise.reject(new Error("ENOENT")),
        attach: () => {
          throw new Error("unused");
        },
      },
    });
    await expect(missing.inspect()).resolves.toMatchObject({
      available: false,
      reason: "engine_missing",
    });
    const stopped = createPodmanRuntimeBackend({
      hostPlatform: "linux",
      control: {
        run: async () => ({ exitCode: 125, stdout: "", stderr: "stopped" }),
        attach: () => {
          throw new Error("unused");
        },
      },
    });
    await expect(stopped.inspect()).resolves.toMatchObject({
      available: false,
      reason: "engine_stopped",
    });
    const rootful = createPodmanRuntimeBackend({
      hostPlatform: "linux",
      control: {
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            version: { Version: "5" },
            host: { security: { rootless: false } },
          }),
          stderr: "",
        }),
        attach: () => {
          throw new Error("unused");
        },
      },
    });
    await expect(rootful.inspect()).resolves.toMatchObject({
      available: false,
      reason: "unsupported_policy",
    });
    const windows = createPodmanRuntimeBackend({
      hostPlatform: "win32",
      control: stopped as unknown as PodmanControl,
    });
    await expect(windows.inspect()).resolves.toMatchObject({
      available: false,
      reason: "unsupported_platform",
    });
  });

  it("refuses start-before-inspect, invalid JSON, and failed control commands", async () => {
    const fake = fakeControl();
    const uninspected = createPodmanRuntimeBackend({
      control: fake.control,
      hostPlatform: "linux",
    });
    await expect(uninspected.start(spec)).rejects.toMatchObject({ code: "operational_failure" });

    const invalidInfo = createPodmanRuntimeBackend({
      hostPlatform: "linux",
      control: {
        run: async () => ({ exitCode: 0, stdout: "not-json", stderr: "" }),
        attach: () => {
          throw new Error("unused");
        },
      },
    });
    await expect(invalidInfo.inspect()).rejects.toMatchObject({ code: "operational_failure" });

    for (const failed of ["image", "create"] as const) {
      const control: PodmanControl = {
        async run(args) {
          if (args[0] === "info") {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                version: { version: "5" },
                host: { security: { rootless: true } },
              }),
              stderr: "",
            };
          }
          return {
            exitCode: args[0] === failed ? 125 : 0,
            stdout:
              args[0] === "image"
                ? JSON.stringify({
                    Id: digest,
                    Digest: `sha256:${"e".repeat(64)}`,
                    Config: {
                      Labels: { "io.clarvis.runtime.protocol": RUNTIME_PROTOCOL_REVISION },
                    },
                  })
                : "",
            stderr: "failed",
          };
        },
        attach: () => {
          throw new Error("unused");
        },
      };
      const backend = createPodmanRuntimeBackend({ control, hostPlatform: "linux" });
      await backend.inspect();
      await expect(backend.start(spec)).rejects.toMatchObject({ code: "operational_failure" });
    }
  });

  it("accepts outbound policy and kills an attachment that exceeds stderr bounds", async () => {
    const fake = fakeControl();
    let killed = false;
    let attachedStderr: PassThrough | undefined;
    const control: PodmanControl = {
      async run(args, signal) {
        if (args[0] === "container") {
          const result = await fake.control.run(args, signal);
          const inspected = JSON.parse(result.stdout) as Array<{
            HostConfig: { NetworkMode: string };
          }>;
          inspected[0]!.HostConfig.NetworkMode = "bridge";
          return { ...result, stdout: JSON.stringify(inspected) };
        }
        return fake.control.run(args, signal);
      },
      attach(args) {
        const attached = fake.control.attach(args);
        attachedStderr = attached.stderr as PassThrough;
        return {
          ...attached,
          kill(signal) {
            killed = signal === "SIGKILL";
            attached.kill(signal);
          },
        };
      },
    };
    const backend = createPodmanRuntimeBackend({ control, hostPlatform: "linux" });
    await backend.inspect();
    const outboundSpec = {
      ...spec,
      network: "outbound" as const,
      limits: { ...spec.limits, outputBytes: 1 },
    };
    const session = await backend.start(outboundSpec);
    attachedStderr?.write("too much");
    await Bun.sleep(0);
    expect(killed).toBe(true);
    await session.stop();
    fake.close();
  });
});
