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
  workspace: { id: "workspace", projectId: "project", label: "main", kind: "primary" },
  sourceWorkspaceRoot: "/source",
  retainedWorkspaceRoot: "/state/workspace",
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
  } = {},
) {
  const calls: string[][] = [];
  const kills: NodeJS.Signals[] = [];
  let guest: ReturnType<typeof createExecutionPeer> | undefined;
  let attachedStderr: PassThrough | undefined;
  const control: DockerControl = {
    async run(args) {
      calls.push([...args]);
      if (args[0] === "info")
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            ServerVersion: "29.2.1",
            OSType: "linux",
            SecurityOptions: ["name=seccomp"],
          }),
          stderr: "",
        };
      if (args[0] === "image")
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            (() => {
              const inspected = {
                Id: overrides.image ?? digest,
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
                PidsLimit: 32,
                Memory: 64 * 1024 * 1024,
              },
              Config: { Labels: { "io.clarvis.generation": spec.generation } },
              Mounts: [{ Source: spec.retainedWorkspaceRoot, Destination: "/workspace", RW: true }],
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
      guest = createExecutionPeer({
        role: "guest",
        generation: spec.generation,
        input: hostToGuest,
        output: guestToHost,
        handlers: {
          "runtime.bootstrap": async () => ({
            generation: overrides.guestGeneration ?? spec.generation,
            imageDigest: digest,
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
        exited: new Promise(() => undefined),
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
    close: () => guest?.close(),
  };
}

describe("Docker runtime backend", () => {
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
    expect(fake.calls[2]).toContain("--read-only");
    expect(fake.calls[2]).toContain("no-new-privileges=true");
    expect(fake.calls[2].find((value) => value.startsWith("/tmp:"))).toContain(
      `size=${spec.limits.storageBytes}`,
    );
    expect(fake.calls[2].find((value) => value.startsWith("/mise:"))).toBe(
      `/mise:rw,nosuid,nodev,exec,size=${spec.limits.storageBytes}`,
    );
    const mountIndex = fake.calls[2].indexOf("--mount");
    expect(fake.calls[2][mountIndex + 1]).toBe(
      `type=bind,source=${spec.retainedWorkspaceRoot},target=/workspace`,
    );
    const signal = new AbortController().signal;
    await expect(session.startRun("run", {}, signal)).resolves.toEqual({ runId: "run" });
    await expect(session.steer("run", { text: "continue" }, signal)).resolves.toBeUndefined();
    await expect(session.cancel("run")).resolves.toBeUndefined();
    await session.stop();
    await session.stop();
    expect(fake.calls.at(-2)?.slice(0, 3)).toEqual(["stop", "--time", "5"]);
    expect(fake.calls.at(-1)?.slice(0, 2)).toEqual(["rm", "--force"]);
    fake.close();
  });

  it("fails closed on image, effective policy, internet mode and non-Linux engines", async () => {
    const wrongImage = fixture({ image: `sha256:${"e".repeat(64)}` });
    const imageBackend = createDockerRuntimeBackend({ control: wrongImage.control });
    await imageBackend.inspect();
    await expect(imageBackend.start(spec)).rejects.toMatchObject({ code: "handshake_mismatch" });
    const wrongProtocol = fixture({ protocolRevision: "3" });
    const protocolBackend = createDockerRuntimeBackend({ control: wrongProtocol.control });
    await protocolBackend.inspect();
    await expect(protocolBackend.start(spec)).rejects.toMatchObject({ code: "handshake_mismatch" });
    const privileged = fixture({ privileged: true });
    const policyBackend = createDockerRuntimeBackend({ control: privileged.control });
    await policyBackend.inspect();
    await expect(policyBackend.start(spec)).rejects.toMatchObject({ code: "unsupported_policy" });
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
