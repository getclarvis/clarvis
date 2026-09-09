import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { MockLLM } from "@clarvis/loop/testing";
import { globalPaths, localHostPaths, writeFileDurableSync } from "@clarvis/paths";
import type { ElicitationRequest, HostedRunRef, StartHostedTurnParams } from "@clarvis/protocol";
import { createFileRunHost, type FileRunHostOptions } from "../../src/bootstrap.ts";
import { openHostedProjection } from "../../src/hosting/projection.ts";
import { connectKernelClient } from "../../src/transport/client.ts";
import { connectLocalKernelTransport, listenLocalKernel } from "../../src/transport/local.ts";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanups.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "file host fixture cleanup failed");
});

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error("file host condition timed out");
    await Bun.sleep(1);
  }
}

async function fixture(authenticate?: FileRunHostOptions["authenticate"]) {
  const root = await mkdtemp(join(tmpdir(), "clarvis-file-run-host-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  await mkdir(workspaceRoot);
  await mkdir(globalDir);
  const global = globalPaths(globalDir);
  await writeFile(
    global.settingsFile,
    JSON.stringify({
      default_model: "anthropic/test",
      providers: [{ name: "anthropic", kind: "anthropic" }],
      runtime: { backend: "native" },
      plans: { mode: "off" },
    }),
  );
  await mkdir(global.agentsDir);
  await writeFile(
    join(global.agentsDir, "solo.md"),
    "---\ntools: []\ngrants: []\n---\nYou are solo.\n",
  );
  const paths = localHostPaths({ globalDir, workspaceRoot, owner: "operator", operatorId: "test" });
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  if (paths.endpointDirectory !== undefined) {
    const directory = paths.endpointDirectory;
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
  }
  const released = Promise.withResolvers<void>();
  const entered: string[] = [];
  const host = await createFileRunHost({
    kernel: {
      workspaceRoot,
      globalDir,
      defaultOwner: "operator",
      subscriptions: false,
      logger: NOOP_LOGGER,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "0" }),
      builtins: { tools: false, hooks: false, tasks: false },
      async executeRun(args) {
        const request = args.rawBody as { execution_id: string };
        entered.push(request.execution_id);
        const cancelled = Promise.withResolvers<void>();
        const abort = () => cancelled.resolve();
        if (args.externalSignal?.aborted) abort();
        else args.externalSignal?.addEventListener("abort", abort, { once: true });
        try {
          await Promise.race([released.promise, cancelled.promise]);
          return await executeRun({
            ...args,
            deps: {
              ...args.deps,
              llm: new MockLLM({ script: [{ text: "Finished with no TUI connected." }] }),
            },
          });
        } finally {
          args.externalSignal?.removeEventListener("abort", abort);
        }
      },
    },
    hostGeneration: "generation",
    authenticate:
      authenticate ??
      ((token) =>
        token === "operator-token"
          ? "operator"
          : token === "observer-token"
            ? "observer"
            : undefined),
    storage: {
      projection: (id) =>
        openHostedProjection(paths.projectionFile("generation", id), {
          host_generation: "generation",
          execution_id: id,
        }),
      async removeProjection(id) {
        await rm(paths.projectionFile("generation", id));
      },
      async commit(state) {
        writeFileDurableSync(paths.registryFile, JSON.stringify(state));
      },
    },
  });
  cleanups.push(() => host.close());
  const listener = await listenLocalKernel(host.server, paths.endpoint);
  cleanups.push(() => listener.close());
  const connect = async (auth = "operator-token", workspace?: string) => {
    const transport = await connectLocalKernelTransport(paths.endpoint);
    cleanups.push(() => transport.close());
    return connectKernelClient(transport, {
      auth,
      ...(workspace === undefined ? {} : { workspace }),
    });
  };
  const client = await connect();
  await client.sessions.save({
    id: "conversation",
    title: "Background example",
    project_id: client.project.id,
    workspace: client.workspace.id,
    created_at: 1,
    updated_at: 1,
    turns: [],
    totals: { input: 0, output: 0, cached: 0 },
  });
  const input = async (id: string): Promise<StartHostedTurnParams> => ({
    session_id: "conversation",
    session_revision: (await client.sessions.get("conversation"))!.revision!,
    kind: "conversation",
    user_preview: "Run while I am away",
    params: {
      execution_id: id,
      agent: "solo",
      messages: [{ role: "user", content: "Run while I am away" }],
    },
  });
  const handoff = (run: HostedRunRef) => ({
    execution_id: run.execution_id,
    host_generation: run.host_generation,
    revision: run.revision,
    control_epoch: run.control_epoch,
    operation_id: "handoff",
  });
  return { host, paths, client, connect, input, entered, released, handoff };
}

describe("file kernel behind the hosted RPC", () => {
  test("runtime preparation notices reach operator inspection as bounded sequenced data", async () => {
    const f = await fixture();
    f.host.runtimeNotice("Preparing Docker environment: test");
    const first = (await f.client.localHost!.inspect()).runtime_notice!;
    expect(first.message).toBe("Preparing Docker environment: test");
    f.host.runtimeNotice("preparing ".repeat(600));
    const next = (await f.client.localHost!.inspect()).runtime_notice!;
    expect(next.message.length).toBe(4096);
    expect(next.sequence).toBeGreaterThan(first.sequence);
  });

  test("an authenticated handshake cannot enter after an idle restart was accepted", async () => {
    const entered = Promise.withResolvers<void>();
    const authenticated = Promise.withResolvers<"operator">();
    const f = await fixture(async (token) => {
      if (token === "late-token") {
        entered.resolve();
        return authenticated.promise;
      }
      return token === "operator-token" ? "operator" : undefined;
    });
    const late = f.connect("late-token");
    const rejected = expect(late).rejects.toMatchObject({ code: "unavailable" });
    await entered.promise;
    await f.client.localHost!.requestRestart();
    authenticated.resolve("operator");
    await rejected;
    expect(f.host.stats().restartRequested).toBe(true);
    expect(f.host.stats().connections).toBe(1);
  });

  test("only the local activity owner can persist observations before releasing conversation admission", async () => {
    const f = await fixture();
    const other = await f.connect();
    const lease = await f.client.hosting!.reserveActivity("conversation", "shell");
    const original = (await f.client.sessions.get("conversation"))!;
    const update = {
      ...original,
      pending: [{ role: "user" as const, content: "Local command completed" }],
    };
    await expect(other.sessions.save(update)).rejects.toMatchObject({ code: "conflict" });
    await expect(other.hosting!.start(await f.input("while-shell"))).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(f.client.runs.compact("previous-run")).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.client.sessions.save({
        ...update,
        turns: [
          { kind: "conversation", execution_id: "forged", user_preview: "forged", status: "done" },
        ],
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await f.client.sessions.save(update);
    const saved = (await f.client.sessions.get("conversation"))!;
    expect(saved.pending).toEqual(update.pending);
    expect(saved.revision).toBe(original.revision! + 1);
    expect(saved.turns).toEqual([]);
    expect(f.host.stats().activities).toBe(1);
    await f.client.hosting!.releaseActivity(lease.lease_id);
    expect(f.host.stats().activities).toBe(0);
    const started = await other.hosting!.start(await f.input("after-shell"));
    await until(() => f.entered.length === 1);
    f.released.resolve();
    expect((await started.handle.done).status).toBe("completed");
    await started.handle.closed;
    expect(f.entered).toEqual(["after-shell"]);
  });

  test("executes after disconnect and reconciles the same run into its conversation before reattachment", async () => {
    const f = await fixture();
    const started = await f.client.hosting!.start(await f.input("background-run"));
    await until(() => f.entered.length === 1);
    expect(started.run.config).toMatchObject({ agent: "solo", model: "anthropic/test" });
    expect(started.run.config.extension_profile?.fingerprint).toBeString();
    const intent = (await f.client.sessions.get("conversation"))!;
    expect(intent.turns).toHaveLength(1);
    expect(intent.turns[0]).toMatchObject({ execution_id: "background-run", status: "running" });
    const refused = await f.client.runs.start({ messages: [] });
    expect(await refused.done).toMatchObject({ status: "failed", error: { code: "unsupported" } });
    await expect(f.client.runs.compact("background-run")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(f.client.sessions.save(intent)).rejects.toMatchObject({ code: "conflict" });
    await expect(f.client.sessions.delete("conversation")).rejects.toMatchObject({
      code: "conflict",
    });
    await expect(f.client.runs.delete("background-run")).rejects.toMatchObject({
      code: "conflict",
    });
    const [run] = await f.client.hosting!.list();
    await f.client.hosting!.detach(f.handoff(run!));
    await f.client.close();
    await until(() => f.host.stats().connections === 0);
    expect(f.host.stats().runs).toBe(1);
    f.released.resolve();
    await until(() => f.host.stats().runs === 0);
    const client = await f.connect();
    const [completed] = await client.hosting!.list();
    expect(completed).toMatchObject({
      execution_id: "background-run",
      execution_state: "closed",
      outcome: { status: "completed" },
    });
    const attached = await client.hosting!.attach({
      execution_id: "background-run",
      host_generation: "generation",
      control: "observe",
    });
    expect((await attached.handle.done).result).toBe("Finished with no TUI connected.");
    expect(f.entered).toEqual(["background-run"]);
    expect((await client.sessions.get("conversation"))!.turns).toMatchObject([
      { execution_id: "background-run", status: "done" },
    ]);
    const index = await readFile(f.paths.registryFile, "utf8");
    expect(index).toContain("background-run");
    expect(index).not.toContain("operator-token");
    expect(index).not.toContain("configuration_session_id");
  });

  test("authenticates each connection and limits observers to non-sensitive reads", async () => {
    const f = await fixture();
    await expect(f.connect("wrong-token")).rejects.toMatchObject({ code: "unauthorized" });
    await expect(f.connect("operator-token", "another-workspace")).rejects.toMatchObject({
      code: "invalid_request",
    });
    const observer = await f.connect("observer-token");
    expect(await observer.hosting!.list()).toEqual([]);
    await expect(observer.secrets.listNames()).rejects.toMatchObject({ code: "unauthorized" });
    await expect(observer.hosting!.start(await f.input("forbidden"))).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(f.entered).toEqual([]);
  });

  test("keeps native configuration attached and retires consent on connection loss", async () => {
    const f = await fixture();
    const input = await f.input("configuration-run");
    input.params.skill = { name: "clarvis-configure", task: "Inspect the settings" };
    input.params.configuration_session_id = "caller-cannot-grant-this";
    const started = await f.client.hosting!.start(input);
    const questions: ElicitationRequest[] = [];
    started.handle.onElicit((question) => {
      questions.push(question);
    });
    await until(() => questions.length > 0);
    expect(questions[0]!.kind).toBe("configuration_access");
    expect(started.run.config.agent).toBe("clarvis-configure");
    const [run] = await f.client.hosting!.list();
    await expect(f.client.hosting!.detach(f.handoff(run!))).rejects.toMatchObject({
      code: "conflict",
    });
    await f.client.close();
    await until(() => f.host.stats().runs === 0);
    expect(f.entered).toEqual([]);
    const resumed = await f.connect();
    const session = (await resumed.sessions.get("conversation"))!;
    const second = await resumed.hosting!.start({
      ...input,
      session_revision: session.revision!,
      params: { ...input.params, execution_id: "resumed-configuration" },
    });
    const next = Promise.withResolvers<ElicitationRequest>();
    second.handle.onElicit((question) => next.resolve(question));
    expect((await next.promise).kind).toBe("configuration_access");
    await second.handle.respond({ id: (await next.promise).id, action: "decline" });
    expect((await second.handle.done).status).toBe("failed");
  });
});
