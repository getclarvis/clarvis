import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { globalPaths } from "@clarvis/paths";
import { connectOrLaunchLocalKernel } from "../../src/hosting/launcher.ts";
import {
  readLocalHostConnection,
  resolveLocalHostIdentity,
} from "../../src/hosting/local-state.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(predicate: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error("independent host condition timed out");
    await Bun.sleep(10);
  }
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clarvis-host-process-"));
  const workspaceRoot = join(root, "workspace with spaces");
  const globalDir = join(root, "global");
  await mkdir(workspaceRoot);
  await mkdir(globalDir);
  const paths = globalPaths(globalDir);
  await mkdir(paths.agentsDir);
  await writeFile(
    join(paths.agentsDir, "solo.md"),
    "---\ntools: []\ngrants: []\n---\nYou are solo.\n",
  );
  await writeFile(
    paths.settingsFile,
    JSON.stringify({
      default_model: "anthropic/test",
      providers: [{ name: "anthropic", kind: "anthropic" }],
      runtime: { backend: "native" },
      plans: { mode: "off" },
      memory: { enabled: false },
    }),
  );
  const identity = await resolveLocalHostIdentity({ workspaceRoot, globalDir, owner: "operator" });
  cleanups.push(async () => {
    await writeFile(join(workspaceRoot, "continue.flag"), "continue");
    await until(async () => (await readLocalHostConnection(identity)) === null, 30_000);
    if (identity.paths.endpointDirectory !== undefined)
      await rm(identity.paths.endpointDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  const options = {
    workspaceRoot,
    globalDir,
    owner: "operator",
    artifactId: "process-fixture",
    command: [
      process.execPath,
      join(import.meta.dir, "../fixtures/local-host-process.ts"),
    ] as const,
    environment: {
      ...process.env,
      CLARVIS_AGENT_TOOLS_ENABLED: "0",
      CLARVIS_AGENT_TOOLS_MAX_GRANT: "read",
    },
  };
  return { workspaceRoot, globalDir, identity, options };
}

describe("independent local kernel process", () => {
  test("finishes after its launching client exits and reconnects to the same execution", async () => {
    const f = await fixture();
    const peer = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../fixtures/local-host-peer.ts"),
        f.workspaceRoot,
        f.globalDir,
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const output = new Response(peer.stderr).text();
    expect(await peer.exited, await output).toBe(0);
    const exitedAt = Date.now();
    const record = (await readLocalHostConnection(f.identity))!;
    expect(record.pid).not.toBe(peer.pid);
    expect(record.pid).not.toBe(process.pid);
    expect(
      await access(join(f.workspaceRoot, "after-exit.json")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const entered = JSON.parse(await readFile(join(f.workspaceRoot, "entered.json"), "utf8"));
    expect(entered).toMatchObject({
      executionId: "process-run",
      pid: record.pid,
      tools: "0",
      maxGrant: "read",
    });
    await writeFile(join(f.workspaceRoot, "continue.flag"), "continue");
    await until(() =>
      access(join(f.workspaceRoot, "after-exit.json")).then(
        () => true,
        () => false,
      ),
    );
    const produced = JSON.parse(await readFile(join(f.workspaceRoot, "after-exit.json"), "utf8"));
    expect(produced).toMatchObject({ executionId: "process-run", pid: record.pid });
    expect(produced.at).toBeGreaterThanOrEqual(exitedAt);
    const { client } = await connectOrLaunchLocalKernel(f.options);
    cleanups.push(() => client.close());
    expect(client.capabilities.hosting!.host_generation).toBe(record.host_generation);
    await until(async () => (await client.hosting!.list())[0]?.execution_state === "closed");
    const receipt = await client.hosting!.receipt("process-handoff");
    expect(receipt!.run.outcome).toMatchObject({ status: "completed" });
    const attached = await client.hosting!.attach({
      execution_id: "process-run",
      host_generation: record.host_generation,
      control: "observe",
    });
    expect((await attached.handle.done).result).toBe("Completed in the independent host.");
    await Array.fromAsync(attached.handle.events);
    await attached.handle.closed;
    expect((await client.sessions.get("conversation"))!.turns).toMatchObject([
      { execution_id: "process-run", status: "done" },
    ]);
    await client.close();
    await until(async () => (await readLocalHostConnection(f.identity)) === null);
    const next = await connectOrLaunchLocalKernel(f.options);
    cleanups.push(() => next.client.close());
    expect(next.client.capabilities.hosting!.host_generation).not.toBe(record.host_generation);
    const [archived] = await next.client.hosting!.list();
    expect(archived).toMatchObject({
      execution_id: "process-run",
      execution_state: "closed",
      host_generation: record.host_generation,
    });
    await expect(
      next.client.hosting!.attach({
        execution_id: "process-run",
        host_generation: record.host_generation,
        control: "observe",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await next.client.runs.get("process-run")).result?.status).toBe("completed");
    await next.client.hosting!.acknowledge("process-run");
    expect(await next.client.hosting!.list()).toEqual([]);
    await next.client.close();
  });

  test("concurrent launchers share one generation and refuse a live incompatible artifact", async () => {
    const f = await fixture();
    const clients = await Promise.all([
      connectOrLaunchLocalKernel(f.options),
      connectOrLaunchLocalKernel(f.options),
    ]);
    for (const { client } of clients) cleanups.push(() => client.close());
    expect(clients[0]!.client.capabilities.hosting).toEqual(
      clients[1]!.client.capabilities.hosting,
    );
    const first = await readLocalHostConnection(f.identity);
    await expect(
      connectOrLaunchLocalKernel({ ...f.options, artifactId: "different-build" }),
    ).rejects.toMatchObject({ code: "unsupported" });
    expect((await readLocalHostConnection(f.identity))!.host_generation).toBe(
      first!.host_generation,
    );
    for (const { client } of clients) await client.close();
  });
});
