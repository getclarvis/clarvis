import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { globalPaths } from "@clarvis/paths";
import { isAlive, killTree } from "@clarvis/tools/shell";

import { connectOrLaunchLocalKernel } from "../../src/hosting/launcher.ts";
import {
  localHostEndpointRootCandidates,
  readLocalHostConnection,
  resolveLocalHostIdentity,
} from "../../src/hosting/local-state.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "local host cleanup failed");
});

async function until(predicate: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error("independent host condition timed out");
    await Bun.sleep(10);
  }
}

async function fixture(environmentOverrides: Readonly<Record<string, string | undefined>> = {}) {
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
  const environment = {
    ...process.env,
    CLARVIS_AGENT_TOOLS_ENABLED: "0",
    CLARVIS_AGENT_TOOLS_MAX_GRANT: "read",
    ...environmentOverrides,
  };
  const identity = await resolveLocalHostIdentity({
    workspaceRoot,
    globalDir,
    owner: "operator",
    endpointRootCandidates: localHostEndpointRootCandidates(environment),
  });
  cleanups.push(async () => {
    await writeFile(join(workspaceRoot, "continue.flag"), "continue");
    await writeFile(join(workspaceRoot, "finish.flag"), "finish");
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
    environment,
  };
  return { workspaceRoot, globalDir, identity, options };
}

describe("independent local kernel process", () => {
  test.skipIf(process.platform === "win32")(
    "falls back from a long temp snapshot and reconnects to the same generation",
    async () => {
      const longRoot = (label: string): string => join("/tmp", `${label}-${"a".repeat(168)}`);
      const f = await fixture({
        TMPDIR: longRoot("tmpdir"),
        TMP: longRoot("tmp"),
        TEMP: longRoot("temp"),
      });
      const first = await connectOrLaunchLocalKernel(f.options);
      cleanups.push(() => first.client.close());
      const record = (await readLocalHostConnection(first.identity))!;
      expect(record).toBeDefined();
      expect(dirname(first.identity.paths.endpointDirectory!)).toBe(resolve("/tmp"));
      expect(record.endpoint).toBe(first.identity.paths.endpoint);
      expect(Buffer.byteLength(record.endpoint, "utf8")).toBeLessThanOrEqual(100);
      expect(first.client.capabilities.hosting!.host_generation).toBe(record.host_generation);

      const second = await connectOrLaunchLocalKernel(f.options);
      cleanups.push(() => second.client.close());
      expect(second.identity.paths.endpoint).toBe(first.identity.paths.endpoint);
      expect(second.client.capabilities.hosting!.host_generation).toBe(record.host_generation);
      await second.client.close();
      await first.client.close();
    },
  );

  test("retires an idle memory-capable process with workspace memory disabled", async () => {
    const f = await fixture();
    const { client } = await connectOrLaunchLocalKernel(f.options);
    cleanups.push(() => client.close());
    expect(client.capabilities.memory).toBe(true);
    await expect(client.memory.jobs()).rejects.toMatchObject({
      code: "capability_disabled",
      details: { memory_code: "MEMORY_NOT_CONFIGURED" },
    });
    await client.close();
    await until(async () => (await readLocalHostConnection(f.identity)) === null, 5000);
  });

  test.skipIf(process.platform === "win32")(
    "keeps a hosted session through client disconnect and drains it only when its run ends",
    async () => {
      const f = await fixture({
        CLARVIS_AGENT_TOOLS_ENABLED: "1",
        CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
        CLARVIS_TEST_SESSION: "1",
      });
      await writeFile(
        join(f.globalDir, "agents", "solo.md"),
        "---\ntools: []\ngrants: [run_commands]\n---\nYou are solo.\n",
      );
      const { client } = await connectOrLaunchLocalKernel(f.options);
      cleanups.push(() => client.close());
      await client.sessions.save({
        id: "conversation",
        title: "Session handoff",
        project_id: client.project.id,
        workspace: client.workspace.id,
        created_at: 1,
        updated_at: 1,
        turns: [],
        totals: { input: 0, output: 0, cached: 0 },
      });
      const session = (await client.sessions.get("conversation"))!;
      const attachment = await client.hosting!.start({
        session_id: session.id,
        session_revision: session.revision!,
        kind: "conversation",
        user_preview: "Session after disconnect",
        params: {
          execution_id: "session-run",
          agent: "solo",
          guard_mode: "off",
          messages: [{ role: "user", content: "Start session" }],
        },
      });
      const [run] = await client.hosting!.list();
      await client.hosting!.detach({
        execution_id: run!.execution_id,
        host_generation: run!.host_generation,
        control_epoch: run!.control_epoch,
        revision: run!.revision,
        operation_id: "session-handoff",
      });
      await client.close();
      await writeFile(join(f.workspaceRoot, "continue.flag"), "continue");
      const marker = join(f.workspaceRoot, "session-meta");
      let sessionPid: number | undefined;
      try {
        await until(
          async () =>
            await access(marker).then(
              () => true,
              () => false,
            ),
        ).catch(async (error) => {
          const probe = await connectOrLaunchLocalKernel(f.options);
          const rows = await probe.client.hosting!.list();
          await probe.client.close();
          throw new Error(`${String(error)}: ${JSON.stringify(rows)}`);
        });
        const [scratch, pidText] = (await readFile(marker, "utf8")).trim().split("\n");
        sessionPid = Number(pidText);
        expect(isAlive(sessionPid)).toBe(true);
        expect(
          await access(scratch).then(
            () => true,
            () => false,
          ),
        ).toBe(true);
        await writeFile(join(f.workspaceRoot, "finish.flag"), "finish");
        const reopened = await connectOrLaunchLocalKernel(f.options);
        cleanups.push(() => reopened.client.close());
        await until(
          async () => (await reopened.client.hosting!.list())[0]?.execution_state === "closed",
        );
        expect(isAlive(sessionPid)).toBe(false);
        expect(
          await access(scratch).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        await attachment.handle.closed;
      } finally {
        if (sessionPid !== undefined && isAlive(sessionPid)) killTree(sessionPid, "SIGKILL");
      }
    },
  );

  test.skipIf(process.platform === "win32")(
    "cancels a hosted session and removes scratch after physical stop",
    async () => {
      const f = await fixture({
        CLARVIS_AGENT_TOOLS_ENABLED: "1",
        CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
        CLARVIS_TEST_SESSION: "1",
      });
      await writeFile(
        join(f.globalDir, "agents", "solo.md"),
        "---\ntools: []\ngrants: [run_commands]\n---\nYou are solo.\n",
      );
      const { client } = await connectOrLaunchLocalKernel(f.options);
      cleanups.push(() => client.close());
      await client.sessions.save({
        id: "conversation-cancel",
        title: "Session cancellation",
        project_id: client.project.id,
        workspace: client.workspace.id,
        created_at: 1,
        updated_at: 1,
        turns: [],
        totals: { input: 0, output: 0, cached: 0 },
      });
      const session = (await client.sessions.get("conversation-cancel"))!;
      const attachment = await client.hosting!.start({
        session_id: session.id,
        session_revision: session.revision!,
        kind: "conversation",
        user_preview: "Cancel session",
        params: {
          execution_id: "session-cancel-run",
          agent: "solo",
          guard_mode: "off",
          messages: [{ role: "user", content: "Start session" }],
        },
      });
      await writeFile(join(f.workspaceRoot, "continue.flag"), "continue");
      const marker = join(f.workspaceRoot, "session-meta");
      let pid: number | undefined;
      try {
        await until(
          async () =>
            await access(marker).then(
              () => true,
              () => false,
            ),
        );
        const [scratch, pidText] = (await readFile(marker, "utf8")).trim().split("\n");
        pid = Number(pidText);
        expect(isAlive(pid)).toBe(true);
        await attachment.handle.cancel();
        await attachment.handle.closed;
        expect(isAlive(pid)).toBe(false);
        expect(
          await access(scratch).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      } finally {
        if (pid !== undefined && isAlive(pid)) killTree(pid, "SIGKILL");
      }
    },
  );

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
    for (const change of [
      { CLARVIS_AGENT_TOOLS_ENABLED: "1", CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec" },
      { CLARVIS_AGENT_TOOLS_MAX_GRANT: "none" },
      { CLARVIS_DEFAULT_ELICIT_WAIT_MS: "1234" },
      { CLARVIS_RETRY_CEILING: "0", CLARVIS_DEFAULT_MAX_RETRIES: "0" },
    ]) {
      await expect(
        connectOrLaunchLocalKernel({
          ...f.options,
          environment: { ...f.options.environment, ...change },
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message: expect.stringContaining("idle host restart"),
      });
      expect((await readLocalHostConnection(f.identity))!.host_generation).toBe(
        record.host_generation,
      );
    }
    await expect(
      connectOrLaunchLocalKernel({ ...f.options, artifactId: "different-build" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: expect.stringContaining("work in progress"),
    });
    expect((await readLocalHostConnection(f.identity))!.host_generation).toBe(
      record.host_generation,
    );
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

  test("concurrent launchers share one generation and replace an idle incompatible artifact", async () => {
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
    const replacement = await connectOrLaunchLocalKernel({
      ...f.options,
      artifactId: "different-build",
    });
    cleanups.push(() => replacement.client.close());
    expect(replacement.client.capabilities.hosting!.host_generation).not.toBe(
      first!.host_generation,
    );
    expect((await readLocalHostConnection(f.identity))!.artifact_id).toBe("different-build");
    for (const { client } of clients) await client.close();
  });
});
