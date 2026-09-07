import { randomUUID } from "node:crypto";
import { expect, test } from "bun:test";
import { createDockerRuntimeBackend, type RuntimeLaunchSpec } from "../../src/index.ts";
import { createNodeDockerControl } from "../../src/local.ts";

const image = process.env.CLARVIS_DOCKER_RUNTIME_IMAGE_DIGEST;
const context = process.env.CLARVIS_DOCKER_RUNTIME_CONTEXT;
const enabled =
  process.env.CLARVIS_DOCKER_RUNTIME_CANARY === "1" &&
  /^sha256:[a-f0-9]{64}$/u.test(image ?? "") &&
  Boolean(context);

test.skipIf(!enabled)(
  "writes ordinary Linux-owned workspace files without DAC capabilities and reuses the user-owned mise cache",
  async () => {
    const docker = Bun.which("docker");
    if (docker === null || image === undefined || context === undefined)
      throw new Error("missing Docker canary inputs");
    const control = createNodeDockerControl({
      executable: docker,
      context,
      environment: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
      },
    });
    const volume = `clarvis-uid-e2e-${randomUUID()}`;
    const caches = new Set<string>();
    const sessions: Array<{ stop(): Promise<void> }> = [];
    const run = async (args: string[]): Promise<string> => {
      const result = await control.run(args);
      if (result.exitCode !== 0)
        throw new Error(`Docker canary ${args[0]} failed: ${result.stderr}`);
      return result.stdout;
    };
    await run(["volume", "create", volume]);
    try {
      const workspaceRoot = (
        JSON.parse(await run(["volume", "inspect", volume])) as Array<{ Mountpoint: string }>
      )[0]!.Mountpoint;
      await run([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--entrypoint",
        "/bin/sh",
        "--mount",
        `type=volume,source=${volume},target=/fixture`,
        image,
        "-euc",
        "printf initial > /fixture/existing; chown 1001:1002 /fixture /fixture/existing; chmod 0755 /fixture; chmod 0644 /fixture/existing",
      ]);
      const denied = await control.run([
        "run",
        "--rm",
        "--network",
        "none",
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--entrypoint",
        "/bin/sh",
        "--mount",
        `type=volume,source=${volume},target=/fixture`,
        image,
        "-c",
        "printf denied >> /fixture/existing",
      ]);
      expect(denied.exitCode).not.toBe(0);
      expect(denied.stderr).toContain("Permission denied");
      const backend = createDockerRuntimeBackend({
        control,
        hostPlatform: "linux",
        hostUser: { uid: 1001, gid: 1002 },
      });
      expect(await backend.inspect()).toMatchObject({ available: true, rootless: false });
      for (let attempt = 0; attempt < 2; attempt++) {
        const generation = `uid-e2e-${randomUUID()}`;
        const spec: RuntimeLaunchSpec = {
          generation,
          ownerId: volume,
          project: { id: volume },
          workspace: { id: volume, projectId: volume, label: "DAC canary", kind: "primary" },
          workspaceRoot,
          readOnlyWorkspacePaths: [],
          imageDigest: image,
          configurationRevision: "test",
          extensionRevision: "test",
          network: "none",
          capabilityMethods: [],
          limits: {
            cpuCount: 1,
            memoryBytes: 256 * 1024 * 1024,
            processCount: 64,
            outputBytes: 1024 * 1024,
            storageBytes: 64 * 1024 * 1024,
          },
        };
        const session = await backend.start(spec);
        sessions.push(session);
        const name = `clarvis-runtime-${generation}`;
        const inspected = (
          JSON.parse(await run(["container", "inspect", name])) as Array<{
            Config: { User: string };
            Mounts: Array<{ Name?: string; Destination: string }>;
          }>
        )[0]!;
        expect(inspected.Config.User).toBe("1001:1002");
        caches.add(inspected.Mounts.find((mount) => mount.Destination === "/mise")!.Name!);
        expect(caches.size).toBe(1);
        const command =
          attempt === 0
            ? "printf appended >> /workspace/existing; printf created > /workspace/new; printf retained > /mise/reuse-token"
            : 'test "$(cat /mise/reuse-token)" = retained; test "$(cat /workspace/existing)" = initialappended';
        await run([
          "exec",
          name,
          "/bin/sh",
          "-euc",
          `${command}; test "$(id -u):$(id -g)" = 1001:1002; test "$(stat -c %u:%g /mise)" = 1001:1002; test ! -e /cache/ready; grep -q 'CapEff:.*0000000000000000' /proc/self/status`,
        ]);
        await session.stop();
      }
    } finally {
      for (const session of sessions) await session.stop();
      for (const cache of caches) await run(["volume", "rm", cache]);
      await run(["volume", "rm", volume]);
    }
  },
  120_000,
);
