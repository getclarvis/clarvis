import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { MockLLM, type MockLLMScriptStep } from "@clarvis/loop/testing";
import { globalPaths, localHostPaths, writeFileDurableSync } from "@clarvis/paths";
import type { ElicitationRequest, HostedRunRef, StartHostedTurnParams } from "@clarvis/protocol";
import { createFileRunHost, type FileRunHostOptions } from "../../src/bootstrap.ts";
import { openHostedProjection } from "../../src/hosting/projection.ts";
import { connectKernelClient } from "../../src/transport/client.ts";
import { connectLocalKernelTransport, listenLocalKernel } from "../../src/transport/local.ts";
import { decodeHostedRegistryState } from "../../src/hosting/state.ts";

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

async function fixture(
  authenticate?: FileRunHostOptions["authenticate"],
  script?: MockLLMScriptStep[],
  exposeLocalControls = true,
) {
  const root = await mkdtemp(join(tmpdir(), "clarvis-file-run-host-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const workspaceRoot = join(root, "workspace");
  const globalDir = join(root, "global");
  await mkdir(workspaceRoot);
  await mkdir(globalDir);
  const goalLlm = script === undefined ? undefined : new MockLLM({ script });
  const responder =
    goalLlm ?? new MockLLM({ script: [{ text: "Finished with no TUI connected." }] });
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const wire = (await request.json()) as { prompt_cache_key: string };
      const result = await responder.call({
        model: "test",
        provider: "fixture",
        messages: [],
        tools: [],
        promptCacheKey: wire.prompt_cache_key,
      });
      const calls = result.toolCalls ?? [];
      const chunk = {
        id: "file-host-fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "test",
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              ...(calls.length === 0
                ? { content: result.text }
                : {
                    tool_calls: calls.map((call, index) => ({
                      index,
                      id: call.id,
                      type: "function",
                      function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                    })),
                  }),
            },
            finish_reason: calls.length === 0 ? "stop" : "tool_calls",
          },
        ],
        usage: {
          prompt_tokens: result.usage.input_tokens,
          completion_tokens: result.usage.output_tokens,
          prompt_tokens_details: { cached_tokens: result.usage.cached_tokens },
        },
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  cleanups.push(() => Promise.resolve(provider.stop(true)));
  const global = globalPaths(globalDir);
  await writeFile(
    global.settingsFile,
    JSON.stringify({
      default_model: "fixture/test",
      providers: [
        {
          name: "fixture",
          kind: "openai-compatible",
          base_url: `http://127.0.0.1:${String(provider.port)}/v1`,
        },
      ],
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
  const hostOptions: FileRunHostOptions = {
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
          return await executeRun(args);
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
    exposeLocalControls,
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
  };
  const host = await createFileRunHost(hostOptions);
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
    agent_profile: "solo",
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
  return {
    host,
    hostOptions,
    listener,
    paths,
    client,
    connect,
    input,
    entered,
    released,
    handoff,
    goalLlm,
  };
}

describe("file kernel behind the hosted RPC", () => {
  test("keeps hosted goal authority while withholding machine-local controls", async () => {
    const f = await fixture(undefined, undefined, false);

    expect(f.client.capabilities.hosting).toEqual({ host_generation: "generation" });
    expect(f.client.capabilities.goals).toBe(true);
    expect(f.client.capabilities.local_host).toBeUndefined();
    expect(f.client.localHost).toBeUndefined();
    expect(await f.client.goals.availability()).toEqual({ available: true });
  });

  test("starts a durable goal over IPC and admits its checkpoint continuation through the real kernel", async () => {
    const f = await fixture(undefined, [
      {
        toolCalls: [
          {
            name: "update_goal",
            arguments: {
              update: {
                action: "checkpoint",
                summary: "First stage",
                next_step: "Finish the task",
              },
            },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "update_goal",
            arguments: {
              update: {
                action: "candidate",
                summary: "Finished",
                assessments: [
                  {
                    criterion_id: "objective",
                    kind: "qualitative",
                    justification: "The synthetic task is complete",
                  },
                ],
              },
            },
          },
        ],
      },
      { text: "Done" },
    ]);
    expect(await f.client.goals.availability()).toEqual({ available: true });
    expect(await f.host.kernel.goals.availability()).toMatchObject({ available: false });
    expect(f.host.kernel.scopePolicy.goals).toEqual(["owner", "workspace", "connection"]);
    const observer = await f.connect("observer-token");
    const invalidations: unknown[] = [];
    const unsubscribe = await observer.goals.subscribe("conversation", (change) => {
      invalidations.push(change);
    });
    await expect(observer.goals.subscribe("missing-session", () => {})).rejects.toMatchObject({
      code: "not_found",
    });
    const request = {
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create-goal",
      action: {
        kind: "create" as const,
        objective: "Complete both fixture stages",
        limits: { max_net_tokens: 10000 },
      },
    };
    await expect(observer.goals.control(request)).rejects.toMatchObject({ code: "unauthorized" });
    expect((await observer.goals.get("conversation")).state.current).toBeUndefined();
    const receipt = await f.client.goals.control(request);
    expect(receipt.execution_id).toBeDefined();
    expect(f.entered).toEqual([receipt.execution_id!]);
    expect(await f.client.goals.control(request)).toEqual(receipt);
    expect(await observer.goals.receipt("conversation", "create-goal")).toEqual(receipt);
    expect(f.entered).toHaveLength(1);
    f.released.resolve();
    await until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "complete",
    );
    await until(() => f.host.stats().runs === 0);
    const view = await f.client.goals.get("conversation");
    expect(view.state.current).toMatchObject({ status: "complete", auto_continuations: 1 });
    expect(view.state.current!.runs.map((run) => run.execution_id)).toEqual(f.entered);
    expect(f.entered).toHaveLength(2);
    expect(view.physical_run).toBeUndefined();
    await until(() => invalidations.length >= 5);
    expect(
      invalidations.every((change) => JSON.stringify(change) === '{"session_id":"conversation"}'),
    ).toBe(true);
    unsubscribe();
    expect(new Set(f.goalLlm!.calls.map((call) => call.promptCacheKey)).size).toBe(1);
    const session = (await f.client.sessions.get("conversation"))!;
    expect(session.turns.map((turn) => turn.execution_id)).toEqual(f.entered);
    expect(session.agent_instance_id).toBeDefined();
    expect(await f.client.goals.control(request)).toEqual(receipt);
    expect(f.entered).toHaveLength(2);
  });

  test("pause retains physical work, fences foreign control and prevents automatic continuation", async () => {
    const f = await fixture(undefined, [
      {
        toolCalls: [
          {
            name: "update_goal",
            arguments: {
              update: { action: "checkpoint", summary: "Stage", next_step: "Next stage" },
            },
          },
        ],
      },
    ]);
    const receipt = await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create-goal",
      action: {
        kind: "create",
        objective: "Continue after a checkpoint",
        limits: { max_net_tokens: 10000 },
      },
    });
    const other = await f.connect();
    const current = await f.client.goals.get("conversation");
    const pause = {
      session_id: "conversation",
      expected_revision: current.state.revision,
      operation_id: "pause",
      action: { kind: "pause" as const },
    };
    await expect(other.goals.control(pause)).rejects.toMatchObject({ code: "conflict" });
    await f.client.goals.control(pause);
    expect((await f.client.goals.get("conversation")).physical_run?.execution_id).toBe(
      receipt.execution_id,
    );
    f.released.resolve();
    await until(() => f.host.stats().runs === 0);
    expect((await f.client.goals.get("conversation")).state.current?.status).toBe("paused");
    expect(f.entered).toHaveLength(1);
    await expect(f.client.hosting!.start(await f.input("ordinary"))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.entered).toHaveLength(1);
  });

  test("background retires goal authority and receipt replay cannot reacquire it", async () => {
    const f = await fixture(undefined, [
      {
        toolCalls: [
          {
            name: "update_goal",
            arguments: { update: { action: "checkpoint", summary: "Stage", next_step: "Finish" } },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "update_goal",
            arguments: {
              update: {
                action: "candidate",
                summary: "Finished",
                assessments: [
                  {
                    criterion_id: "objective",
                    kind: "qualitative",
                    justification: "Task finished",
                  },
                ],
              },
            },
          },
        ],
      },
      { text: "Done" },
    ]);
    const request = {
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create-goal",
      action: {
        kind: "create" as const,
        objective: "Finish after explicit resume",
        limits: { max_net_tokens: 10000 },
      },
    };
    const receipt = await f.client.goals.control(request);
    const attachment = await f.client.hosting!.attach({
      execution_id: receipt.execution_id!,
      host_generation: "generation",
      control: "acquire",
    });
    await f.client.hosting!.detach(f.handoff(attachment.run));
    await until(
      async () => (await f.client.goals.get("conversation")).state.current?.status === "paused",
    );
    f.released.resolve();
    await until(() => f.host.stats().runs === 0);
    expect(f.entered).toHaveLength(1);
    expect(await f.client.goals.control(request)).toEqual(receipt);
    const next = await f.connect();
    const current = await next.goals.get("conversation");
    await next.goals.control({
      session_id: "conversation",
      expected_revision: current.state.revision,
      operation_id: "resume",
      action: { kind: "resume" },
    });
    await until(
      async () => (await next.goals.get("conversation")).state.current?.status === "complete",
    );
    await until(() => f.host.stats().runs === 0);
    expect(f.entered).toHaveLength(2);
    expect(
      (await next.goals.get("conversation")).state.current!.consumption.net_tokens,
    ).toBeGreaterThan(0);
  });

  test("lost process authority blocks the internal automatic start before inference", async () => {
    const f = await fixture(undefined, [
      {
        toolCalls: [
          {
            name: "update_goal",
            arguments: {
              update: { action: "checkpoint", summary: "Stage", next_step: "Continue" },
            },
          },
        ],
      },
    ]);
    await f.client.goals.control({
      session_id: "conversation",
      expected_revision: 0,
      operation_id: "create-goal",
      action: {
        kind: "create",
        objective: "Preserve host authority",
        limits: { max_net_tokens: 10000 },
      },
    });
    f.hostOptions.assertAuthority = async () => {
      throw new Error("Fixture process lease was retired");
    };
    f.released.resolve();
    await until(
      async () =>
        (await f.host.kernel.sessions.get("conversation"))?.goal_state?.current?.status ===
        "blocked",
    );
    await until(() => f.host.stats().runs === 0);
    expect(f.entered).toHaveLength(1);
    expect(f.goalLlm!.calls).toHaveLength(1);
  });

  test("operator recovery preserves the session audit and unlocks maintenance over local IPC", async () => {
    const f = await fixture();
    const attached = await f.client.hosting!.start(await f.input("interrupted"));
    await until(() => f.entered.includes("interrupted"));
    const crashIndex = decodeHostedRegistryState(
      JSON.parse(await readFile(f.paths.registryFile, "utf8")),
    );
    const crashSession = (await f.client.sessions.get("conversation"))!;
    expect(crashSession.turns[0]!.status).toBe("running");
    await f.client.close();
    await f.listener.close();
    await f.host.close();
    const recovered = await createFileRunHost({
      ...f.hostOptions,
      hostGeneration: "recovered",
      storage: {
        ...f.hostOptions.storage,
        initialState: crashIndex,
        removeProjection: async (id, generation) => {
          await rm(f.paths.projectionFile(generation, id), { force: true });
        },
      },
    });
    cleanups.push(() => recovered.close());
    await recovered.kernel.sessions.save(crashSession);
    const listener = await listenLocalKernel(recovered.server, f.paths.endpoint);
    cleanups.push(() => listener.close());
    const transport = await connectLocalKernelTransport(f.paths.endpoint);
    cleanups.push(() => transport.close());
    const client = await connectKernelClient(transport, { auth: "operator-token" });
    const row = (await client.hosting!.list()).find(
      (value) => value.execution_id === attached.run.execution_id,
    )!;
    expect(row.execution_state).toBe("unknown");
    await expect(client.localHost!.requestRestart()).rejects.toMatchObject({ code: "conflict" });
    const resolved = await client.hosting!.resolveRecovery({
      execution_id: row.execution_id,
      host_generation: row.host_generation,
      revision: row.revision,
      physical_work_stopped: true,
    });
    expect(resolved.outcome).toBeUndefined();
    await client.hosting!.acknowledge(row.execution_id);
    expect(await client.hosting!.list()).toEqual([]);
    const archived = (await client.sessions.get("conversation"))!;
    expect(archived.turns[0]).toMatchObject({
      status: "interrupted",
      recovery_resolution: resolved.recovery_resolution,
    });
    expect(archived.turns[0]!.ended_at).toBeUndefined();
    await expect(
      client.hosting!.start({
        session_id: archived.id,
        session_revision: archived.revision!,
        kind: "conversation",
        user_preview: "Never replay",
        params: {
          execution_id: "no-replay",
          agent: "solo",
          messages: [{ role: "user", content: "Never replay" }],
        },
      }),
    ).rejects.toThrow("archived");
    await client.localHost!.requestRestart();
    expect(recovered.stats().restartRequested).toBe(true);
    expect(f.entered).toEqual(["interrupted"]);
  });

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
    expect(started.run.config).toMatchObject({ agent: "solo", model: "fixture/test" });
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
