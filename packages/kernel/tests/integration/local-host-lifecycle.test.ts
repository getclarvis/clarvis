import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { globalPaths } from "@clarvis/paths";
import { serveLocalFileKernel } from "#src/hosting/serve-local.ts";
import { readLocalHostConnection, resolveLocalHostIdentity } from "#src/hosting/local-state.ts";
import { connectKernelClient } from "#src/transport/client.ts";
import { connectLocalKernelTransport } from "#src/transport/local.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clarvis-host-lifecycle-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  await mkdir(workspaceRoot);
  await mkdir(globalDir);
  await writeFile(
    globalPaths(globalDir).settingsFile,
    JSON.stringify({ memory: { enabled: false } }),
  );
  const identity = await resolveLocalHostIdentity({ workspaceRoot, globalDir, owner: "operator" });
  if (identity.paths.endpointDirectory !== undefined) {
    const endpointDirectory = identity.paths.endpointDirectory;
    cleanups.push(() => rm(endpointDirectory, { recursive: true, force: true }));
  }
  const options = {
    kernel: {
      workspaceRoot,
      globalDir,
      defaultOwner: "operator",
      subscriptions: false,
      logger: NOOP_LOGGER,
      env: loadEnv({ CLARVIS_AGENT_TOOLS_ENABLED: "0", CLARVIS_LOG_LEVEL: "silent" }),
      builtins: { tools: false, hooks: false },
    },
    artifactId: "lifecycle-fixture",
    idleTimeoutMs: 500,
    checkIntervalMs: 10,
  };
  const start = async () => {
    const host = await serveLocalFileKernel(options);
    if (host === null) throw new Error("fixture host unexpectedly contended");
    cleanups.push(() => host.close());
    return host;
  };
  const connect = async () => {
    const record = (await readLocalHostConnection(identity))!;
    const transport = await connectLocalKernelTransport(identity.paths.endpoint);
    cleanups.push(() => transport.close());
    return connectKernelClient(transport, { auth: record.credential });
  };
  return { root, options, identity, start, connect };
}

describe("local host process lifecycle composition", () => {
  test("an armed TUI disconnect retires the workspace immediately even with another client", async () => {
    const f = await fixture();
    const host = await serveLocalFileKernel({
      ...f.options,
      idleTimeoutMs: 60_000,
      checkIntervalMs: 60_000,
    });
    if (host === null) throw new Error("fixture host unexpectedly contended");
    cleanups.push(() => host.close());
    const tui = await f.connect();
    const other = await f.connect();
    await tui.localHost!.setDisconnectAction("shutdown");
    const exited = performance.now();
    await tui.close();
    await host.closed;
    expect(performance.now() - exited).toBeLessThan(2000);
    expect(await readLocalHostConnection(f.identity)).toBeNull();
    await expect(other.localHost!.inspect()).rejects.toThrow();
  });

  test("deliberate detach preserves the host and rearming restores workspace shutdown", async () => {
    const f = await fixture();
    const host = await f.start();
    const tui = await f.connect();
    const other = await f.connect();
    await tui.localHost!.setDisconnectAction("shutdown");
    await tui.localHost!.setDisconnectAction("detach");
    await tui.close();
    expect((await other.localHost!.inspect()).host_generation).toBe(host.generation);
    await other.localHost!.setDisconnectAction("shutdown");
    await other.close();
    await host.closed;
    expect(await readLocalHostConnection(f.identity)).toBeNull();
  });

  test("explicit shutdown bypasses the idle timer", async () => {
    const f = await fixture();
    const host = await serveLocalFileKernel({
      ...f.options,
      idleTimeoutMs: 60_000,
      checkIntervalMs: 60_000,
    });
    if (host === null) throw new Error("fixture host unexpectedly contended");
    cleanups.push(() => host.close());
    const tui = await f.connect();
    await tui.localHost!.requestShutdown();
    await host.closed;
    expect(await readLocalHostConnection(f.identity)).toBeNull();
  });

  test("a connected operator prevents idle shutdown and the last disconnect retires discovery", async () => {
    const f = await fixture();
    const host = await f.start();
    const client = await f.connect();
    expect((await client.localHost!.inspect()).host_generation).toBe(host.generation);
    expect(await serveLocalFileKernel(f.options)).toBeNull();
    await Bun.sleep(600);
    expect((await readLocalHostConnection(f.identity))!.host_generation).toBe(host.generation);
    await client.close();
    await host.closed;
    expect(await readLocalHostConnection(f.identity)).toBeNull();
    const next = await f.start();
    expect(next.generation).not.toBe(host.generation);
  });

  test("an accepted idle restart closes its connection and releases its workspace lease", async () => {
    const f = await fixture();
    const host = await f.start();
    const client = await f.connect();
    const lease = await client.hosting!.reserveActivity("conversation", "shell");
    await expect(client.localHost!.requestRestart()).rejects.toMatchObject({ code: "conflict" });
    expect((await client.localHost!.inspect()).restart_requested).toBe(false);
    await client.hosting!.releaseActivity(lease.lease_id);
    await client.localHost!.requestRestart();
    await host.closed;
    expect(await readLocalHostConnection(f.identity)).toBeNull();
    await expect(client.localHost!.inspect()).rejects.toThrow();
    expect((await f.start()).generation).not.toBe(host.generation);
  });

  test("loss of the owned lease closes the listener even with a connected operator", async () => {
    const f = await fixture();
    const host = await f.start();
    const client = await f.connect();
    await rm(f.identity.paths.leaseFile);
    await host.closed;
    await expect(client.localHost!.inspect()).rejects.toThrow();
    expect(host.host.stats().connections).toBe(0);
  });

  test("failed kernel construction leaves neither publication nor a held lease", async () => {
    const f = await fixture();
    await expect(
      serveLocalFileKernel({
        ...f.options,
        kernel: { ...f.options.kernel, extensionProfileSelector: "invalid selector" },
      }),
    ).rejects.toThrow();
    expect(await readLocalHostConnection(f.identity)).toBeNull();
    expect(await f.start()).toBeDefined();
  });

  test.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "invalid lifecycle duration %s is rejected before acquiring authority",
    async (duration) => {
      const f = await fixture();
      await expect(
        serveLocalFileKernel({ ...f.options, idleTimeoutMs: duration }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        serveLocalFileKernel({ ...f.options, checkIntervalMs: duration }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(await readLocalHostConnection(f.identity)).toBeNull();
    },
  );
});
