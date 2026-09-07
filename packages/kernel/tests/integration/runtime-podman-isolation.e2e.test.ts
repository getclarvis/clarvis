import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import {
  createPodmanRuntimeBackend,
  type RuntimeLaunchSpec,
  type RuntimeSession,
} from "../../src/index.ts";
import { createNodePodmanControl } from "../../src/local.ts";

const enabled = process.env.CLARVIS_PODMAN_RUNTIME_CANARY === "1";

test.skipIf(!enabled)(
  "enforces rootless isolation and retains only the same-workspace mise cache across generations",
  async () => {
    const executable = Bun.which("podman");
    const imageDigest = process.env.CLARVIS_PODMAN_RUNTIME_IMAGE_DIGEST;
    const connection = process.env.CLARVIS_PODMAN_RUNTIME_CONNECTION;
    if (executable === null || !/^sha256:[a-f0-9]{64}$/u.test(imageDigest ?? "") || !connection) {
      throw new Error(
        "Podman isolation canary requires executable, canonical image ID and connection",
      );
    }
    const control = createNodePodmanControl({
      executable,
      connection,
      environment: Object.fromEntries(
        ["HOME", "PATH", "XDG_RUNTIME_DIR"].flatMap((key) => {
          const value = process.env[key];
          return value === undefined ? [] : [[key, value]];
        }),
      ),
    });
    const run = async (args: string[]): Promise<string> => {
      const result = await control.run(args);
      if (result.exitCode !== 0) throw new Error(`Podman ${args[0]} failed: ${result.stderr}`);
      return result.stdout;
    };
    const buildRoot = resolve(import.meta.dir, "../../../../build/runtime-e2e");
    await mkdir(buildRoot, { recursive: true });
    const root = await mkdtemp(join(buildRoot, "podman-isolation-"));
    const protectedRoot = join(root, "protected");
    await mkdir(protectedRoot);
    await writeFile(join(root, "existing"), "initial", { mode: 0o644 });
    await writeFile(join(protectedRoot, "proof"), "protected");
    const ownerId = randomUUID();
    const caches = new Set<string>();
    const sessions: RuntimeSession[] = [];
    const names: string[] = [];
    const backend = createPodmanRuntimeBackend({
      control: {
        ...control,
        async run(args, signal) {
          const result = await control.run(args, signal);
          if (result.exitCode === 0 && args[0] === "volume" && args[1] === "create")
            caches.add(args.at(-1)!);
          return result;
        },
      },
    });
    try {
      expect(await backend.inspect()).toMatchObject({ available: true, rootless: true });
      for (let attempt = 0; attempt < 3; attempt++) {
        const generation = `podman-isolation-${randomUUID()}`;
        const spec: RuntimeLaunchSpec = {
          generation,
          ownerId,
          project: { id: ownerId },
          workspace: {
            id: attempt === 2 ? "other" : "same",
            projectId: ownerId,
            label: "isolation",
            kind: "primary",
          },
          workspaceRoot: root,
          readOnlyWorkspacePaths: [protectedRoot],
          imageDigest: imageDigest!,
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
        names.push(name);
        const inspected = JSON.parse(await run(["container", "inspect", name])) as Array<{
          Mounts: Array<{ Name?: string; Destination: string; SubPath?: string }>;
        }>;
        const cache = inspected[0]!.Mounts.find((mount) => mount.Destination === "/mise")!;
        expect(cache.SubPath).toBe("data");
        caches.add(cache.Name!);
        expect(caches.size).toBe(attempt === 2 ? 2 : 1);
        const script = [
          'test "$(id -u):$(id -g)" = 0:0',
          "grep -q 'CapEff:.*0000000000000000' /proc/self/status",
          "grep -q 'CapBnd:.*0000000000000000' /proc/self/status",
          "grep -q 'NoNewPrivs:.*1' /proc/self/status",
          'test "$(cat /sys/fs/cgroup/memory.max)" = 268435456',
          'test "$(cat /sys/fs/cgroup/pids.max)" = 64',
          'test "$(cat /sys/fs/cgroup/cpu.max)" = "100000 100000"',
          'test "$(ls /sys/class/net)" = lo',
          "test ! -S /var/run/docker.sock && test ! -S /run/podman/podman.sock",
          "test ! -e /cache/ready && test ! -e /mise/ready && test ! -e /mise/data",
          "if (printf forbidden > /rootfs-write) 2>/dev/null; then exit 1; fi",
          "if (printf forbidden > /workspace/protected/proof) 2>/dev/null; then exit 1; fi",
          "printf '#!/bin/sh\\nexit 0\\n' > /tmp/noexec; chmod +x /tmp/noexec",
          "if /tmp/noexec 2>/dev/null; then exit 1; fi",
          "printf '#!/bin/sh\\nexit 0\\n' > /mise/executable; chmod +x /mise/executable; /mise/executable",
          attempt === 0
            ? "printf appended >> /workspace/existing; printf guest > /workspace/new; printf retained > /mise/reuse-token; printf volatile > /tmp/volatile"
            : attempt === 1
              ? 'test "$(cat /mise/reuse-token)" = retained; test "$(cat /workspace/existing)" = initialappended; test ! -e /tmp/volatile'
              : "test ! -e /mise/reuse-token",
          "printf ISOLATION_OK",
        ].join("\n");
        expect(await run(["exec", name, "/bin/sh", "-euc", script])).toBe("ISOLATION_OK");
        await session.stop();
        expect((await control.run(["container", "exists", name])).exitCode).toBe(1);
      }
      expect(await readFile(join(protectedRoot, "proof"), "utf8")).toBe("protected");
      expect((await stat(join(root, "new"))).uid).toBe(process.getuid!());
    } finally {
      for (const session of sessions) await session.stop();
      for (const name of names) await control.run(["rm", "--force", name]);
      for (const cache of caches) await run(["volume", "rm", cache]);
      await rm(root, { recursive: true, force: true });
    }
  },
  120_000,
);
