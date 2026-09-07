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
  } = {},
) {
  const calls: readonly string[][] & string[][] = [];
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
      if (args[0] === "container") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              HostConfig: { Privileged: overrides.privileged ?? false, NetworkMode: "none" },
              Config: { Labels: { "io.clarvis.generation": spec.generation } },
              Mounts: [
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
            },
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
      "create",
      "container",
      "start",
    ]);
    expect(fake.calls[2]).toContain("ALL");
    expect(fake.calls[2]).toContain("no-new-privileges");
    expect(fake.calls[2]).toContain(`/mise:rw,nosuid,nodev,exec,size=${spec.limits.storageBytes}`);
    expect(fake.calls[2]).toContain(
      `type=bind,source=${spec.workspaceRoot},target=/workspace,rw=true`,
    );
    expect(fake.calls[2]).toContain(
      "type=bind,source=/work/tree/.clarvis/memory,target=/workspace/.clarvis/memory,ro=true",
    );
    expect(fake.calls[2]).toContain("type=bind,source=/repo/.git,target=/repo/.git,rw=true");
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
          return {
            exitCode: 0,
            stdout: JSON.stringify([
              {
                HostConfig: { Privileged: false, NetworkMode: "slirp4netns" },
                Config: { Labels: { "io.clarvis.generation": spec.generation } },
                Mounts: [
                  { Type: "bind", Source: spec.workspaceRoot, Destination: "/workspace", RW: true },
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
              },
            ]),
            stderr: "",
          };
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
