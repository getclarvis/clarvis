import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { createFileMemoryStore } from "@clarvis/memory";
import { globalPaths } from "@clarvis/paths";
import { serveLocalFileKernel } from "#src/hosting/serve-local.ts";
import { readLocalHostConnection, resolveLocalHostIdentity } from "#src/hosting/local-state.ts";
import { connectKernelClient } from "#src/transport/client.ts";
import { connectLocalKernelTransport } from "#src/transport/local.ts";

async function until(predicate: () => Promise<boolean>, timeout = 5000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error("memory lifecycle condition timed out");
    await Bun.sleep(5);
  }
}

test("TUI exit aborts durable memory and restart recovers it without an interactive hosted run", async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-memory-exit-"));
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  const memoryRoot = join(root, "memory");
  const held = Promise.withResolvers<void>();
  let calls = 0;
  let resumed = false;
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { stream?: boolean };
      calls++;
      if (calls === 2) await held.promise;
      else if (calls > 2) resumed = true;
      const message = { role: "assistant", content: "Nothing to record." };
      const response = {
        id: `response-${calls}`,
        object: "chat.completion",
        created: 1,
        model: "model",
        choices: [{ index: 0, message, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      if (!body.stream) return Response.json(response);
      return new Response(
        `data: ${JSON.stringify({ ...response, choices: [{ index: 0, delta: message, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  const hosts: Array<NonNullable<Awaited<ReturnType<typeof serveLocalFileKernel>>>> = [];
  let endpointDirectory: string | undefined;
  try {
    await mkdir(workspaceRoot);
    await mkdir(globalDir);
    const paths = globalPaths(globalDir);
    await mkdir(paths.agentsDir);
    await writeFile(
      join(paths.agentsDir, "solo.md"),
      "---\ntools: []\ngrants: []\n---\nComplete the fixture.",
    );
    await writeFile(
      paths.settingsFile,
      JSON.stringify({
        default_model: "fixture/model",
        providers: [
          {
            name: "fixture",
            kind: "openai-compatible",
            base_url: `http://127.0.0.1:${provider.port}/v1`,
          },
        ],
        plans: { mode: "off" },
        memory: { enabled: true },
      }),
    );
    const identity = await resolveLocalHostIdentity({
      workspaceRoot,
      globalDir,
      owner: "operator",
    });
    endpointDirectory = identity.paths.endpointDirectory;
    const options = {
      artifactId: "memory-exit-fixture",
      idleTimeoutMs: 60_000,
      checkIntervalMs: 60_000,
      kernel: {
        workspaceRoot,
        globalDir,
        defaultOwner: "operator",
        memory: true,
        subscriptions: false,
        logger: NOOP_LOGGER,
        env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "0" }),
        builtins: { tools: false, hooks: false, skills: false },
        memoryStoreFor: () => createFileMemoryStore({ root: memoryRoot }),
      },
    };
    const first = (await serveLocalFileKernel(options))!;
    hosts.push(first);
    const record = (await readLocalHostConnection(identity))!;
    const transport = await connectLocalKernelTransport(record.endpoint);
    const client = await connectKernelClient(transport, { auth: record.credential });
    await client.localHost!.setDisconnectAction("shutdown");
    await client.sessions.save({
      id: "conversation",
      title: "Memory",
      project_id: client.project.id,
      workspace: client.workspace.id,
      created_at: 1,
      updated_at: 1,
      turns: [],
      totals: { input: 0, output: 0, cached: 0 },
    });
    const session = (await client.sessions.get("conversation"))!;
    const started = await client.hosting!.start({
      session_id: session.id,
      session_revision: session.revision!,
      kind: "conversation",
      user_preview: "Memory subject",
      params: {
        execution_id: "memory-subject",
        agent: "solo",
        memory: "on",
        messages: [{ role: "user", content: "Complete fixture" }],
      },
    });
    void started.handle.closed.catch(() => undefined);
    const events: string[] = [];
    const observing = (async () => {
      for await (const event of started.handle.events) events.push(event.event.type);
    })().catch(() => undefined);
    expect((await started.handle.done).status).toBe("completed");
    const store = createFileMemoryStore({ root: memoryRoot });
    await until(
      async () => calls === 2 && (await store.jobs.get("memory-subject"))?.state === "running",
    );
    await client.close();
    await first.closed;
    await observing;
    expect(await readLocalHostConnection(identity)).toBeNull();
    expect(await store.jobs.get("memory-subject")).toMatchObject({
      state: "pending",
      attempts: 0,
      history: [],
    });
    const second = (await serveLocalFileKernel(options))!;
    hosts.push(second);
    await until(async () => (await store.jobs.get("memory-subject"))?.state === "completed");
    expect(resumed).toBe(true);
    expect(second.host.stats().runs).toBe(0);
    expect(second.host.stats().connections).toBe(0);
    const nextRecord = (await readLocalHostConnection(identity))!;
    const nextTransport = await connectLocalKernelTransport(nextRecord.endpoint);
    const next = await connectKernelClient(nextTransport, { auth: nextRecord.credential });
    try {
      expect(
        (await next.hosting!.list()).filter((run) => run.execution_state !== "closed"),
      ).toEqual([]);
      const history = (await next.sessions.get("conversation"))!;
      expect(history.turns).toHaveLength(1);
      expect(history.turns[0]!.execution_id).toBe("memory-subject");
      expect(events).toContain("memory_ingest");
    } finally {
      await next.close();
    }
  } finally {
    held.resolve();
    for (const host of hosts.reverse()) await host.close();
    await provider.stop(true);
    if (endpointDirectory !== undefined)
      await rm(endpointDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
