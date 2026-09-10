import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { executeRun, type ExecuteRunArgs } from "@clarvis/loop";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import { withTransportRetry } from "@clarvis/llm";
import { createMemory } from "@clarvis/memory";
import { createInMemoryMemoryStore } from "@clarvis/memory/testing";
import {
  createMemoryCapability,
  storedExecutionToRunSnapshot,
  type MemoryFactory,
} from "@clarvis/memory/capability";
import { createPlanStore, type PlanDocument } from "@clarvis/plan";
import { createInMemoryPlanRepository } from "@clarvis/plan/testing";
import { globalPaths } from "@clarvis/paths";
import { createFileKernel, type FileKernel } from "../../src/file-kernel.ts";
import { createHash } from "node:crypto";
import { composePromptCacheKey } from "@clarvis/capability";
import { createOpenAICodexAdapter } from "../../src/subscriptions/openai-codex.ts";
import { subscriptionRegistration } from "../../src/subscriptions/registrations.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("kernel prompt-cache composition through the real SDK transport", () => {
  it("preserves serialized catalogs and history through retry, same-profile children, guard resume and the real indexing pass", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-cache-policy-wire-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    await mkdir(workspaceRoot);
    await mkdir(globalDir);
    await writeFile(join(workspaceRoot, "fact.txt"), "Synthetic workspace fact");
    const paths = globalPaths(globalDir);
    await writeFile(
      paths.settingsFile,
      JSON.stringify({
        default_model: "fixture/cache-model",
        providers: [
          { name: "fixture", kind: "openai-compatible", base_url: "https://fixture.invalid/v1" },
        ],
        runtime: { backend: "native" },
        plans: { mode: "on", pending_task_nudges: 0 },
      }),
    );
    await mkdir(paths.agentsDir);
    for (const name of ["leader", "explorer"])
      await writeFile(
        join(paths.agentsDir, `${name}.md`),
        `---\ntools: []\ngrants: [read_workspace]\niteration_limit: 10\n${name === "leader" ? "can_spawn: [explorer]\n" : ""}---\nVerify synthetic facts.\n`,
      );
    type Wire = {
      prompt_cache_key: string;
      messages: Array<{ role: string; content?: unknown }>;
      tools: Array<{ function: { name: string } }>;
    };
    const requests: Wire[] = [];
    const counts = new Map<string, number>();
    let retryIssued = false;
    let indexing = false;
    let cancelArrival: (() => void) | undefined;
    const transport = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("expected serialized SDK request");
        const body = JSON.parse(init.body) as Wire;
        requests.push(body);
        if (cancelArrival && body.prompt_cache_key === "wire-session_leader") {
          const arrived = cancelArrival;
          cancelArrival = undefined;
          const signal = init.signal;
          if (!signal) throw new Error("expected physical attempt cancellation signal");
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled fixture", "AbortError")),
              { once: true },
            );
            arrived();
          });
        }
        if (!retryIssued) {
          retryIssued = true;
          return new Response("temporarily unavailable", {
            status: 503,
            headers: { "retry-after": "0" },
          });
        }
        const step = (counts.get(body.prompt_cache_key) ?? 0) + 1;
        counts.set(body.prompt_cache_key, step);
        const leader = body.prompt_cache_key === "wire-session_leader";
        const calls = indexing
          ? step === 1
            ? [{ name: "read_file", arguments: { path: "fact.txt" } }]
            : step === 2
              ? [{ name: "read_memory", arguments: { path: "PROFILE.md" } }]
              : []
          : leader && step === 1
            ? ["first", "second"].map((title) => ({
                name: "spawn_subagent",
                arguments: { title, task: "Read fact.txt then finish", profile: "explorer" },
              }))
            : !leader && step === 1
              ? [{ name: "read_file", arguments: { path: "fact.txt" } }]
              : [];
        const delta =
          calls.length > 0
            ? {
                role: "assistant",
                tool_calls: calls.map((call, index) => ({
                  index,
                  id: `call-${requests.length}-${index}`,
                  type: "function",
                  function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                })),
              }
            : { role: "assistant", content: "Synthetic facts verified." };
        const chunk = {
          id: `response-${requests.length}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "cache-model",
          choices: [{ index: 0, delta, finish_reason: calls.length > 0 ? "tool_calls" : "stop" }],
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 10,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const llm = withTransportRetry(new AiSdkAdapter({ fetch: transport }), {
      maxRetries: 1,
      baseDelayMs: 1,
      maxDelayMs: 1,
      maxRetryAfterMs: 1,
    });
    let seed: ExecuteRunArgs | undefined;
    const memory = createMemory({
      store: createInMemoryMemoryStore(),
      indexer: () =>
        seed && {
          owner: seed.owner,
          deps: seed.deps,
          passDeps: seed.deps,
          modelRef: "fixture/cache-model",
          providers: [
            { name: "fixture", kind: "openai-compatible", base_url: "https://fixture.invalid/v1" },
          ],
          executeRun,
        },
    });
    const factory: MemoryFactory = {
      forOwner: () => memory,
      forOwnerControlPlane: () => memory,
      start: () => {},
      poke: () => {},
      stop: async () => {},
      subscribeToRun: () => () => {},
    };
    const capability = createMemoryCapability(factory, { enqueueOnRunEnd: false });
    const kernel = await createFileKernel({
      workspaceRoot,
      globalDir,
      memory: false,
      subscriptions: false,
      logger: NOOP_LOGGER,
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "1" }),
      builtins: { tools: true, hooks: false, tasks: false },
      executeRun: (args) => {
        const execution = {
          ...args,
          deps: {
            ...args.deps,
            llm,
            capabilities: [...(args.deps.capabilities ?? []), capability],
          },
        };
        seed ??= execution;
        return executeRun(execution);
      },
    });
    cleanup.push(() => kernel.close());
    const first = await kernel.runs.start({
      agent: "leader",
      session_id: "wire-session",
      agent_instance_id: "leader",
      guard_mode: "off",
      messages: [{ role: "user", content: "Delegate to two explorers." }],
    });
    for await (const _event of first.events) void _event;
    expect((await first.done).status).toBe("completed");
    expect(requests[1]).toEqual(requests[0]);
    expect(counts.size).toBe(3);
    for (const [key, count] of counts) if (key !== "wire-session_leader") expect(count).toBe(2);
    const arrived = new Promise<void>((resolve) => {
      cancelArrival = resolve;
    });
    const cancelled = await kernel.runs.start({
      agent: "leader",
      continue_from: first.execution_id,
      guard_mode: "off",
      messages: [{ role: "user", content: "Cancel this physical attempt." }],
    });
    await arrived;
    await cancelled.cancel();
    for await (const _event of cancelled.events) void _event;
    expect((await cancelled.done).status).toBe("cancelled");
    const second = await kernel.runs.start({
      agent: "leader",
      continue_from: cancelled.execution_id,
      guard_mode: "on",
      messages: [{ role: "user", content: "Confirm with the guard enabled." }],
    });
    for await (const _event of second.events) void _event;
    expect((await second.done).status).toBe("completed");
    const lead = requests.filter((request) => request.prompt_cache_key === "wire-session_leader");
    expect(lead).toHaveLength(5);
    for (const key of counts.keys()) {
      const series = requests.filter((request) => request.prompt_cache_key === key);
      for (let index = 1; index < series.length; index += 1) {
        expect(series[index]!.tools).toEqual(series[0]!.tools);
        expect(series[index]!.messages.slice(0, series[index - 1]!.messages.length)).toEqual(
          series[index - 1]!.messages,
        );
      }
    }
    indexing = true;
    const source = seed!.deps.traceStore.getById(seed!.owner, first.execution_id)!;
    await memory.enqueue(storedExecutionToRunSnapshot(source, { workspace: workspaceRoot }));
    await memory.drain({ limit: 1 });
    const job = (await memory.jobs())[0]!;
    expect(job.state).toBe("completed");
    const memoryCalls = requests.filter((request) =>
      request.prompt_cache_key.endsWith(`_${job.agent_instance_id}`),
    );
    expect(memoryCalls).toHaveLength(3);
    expect(new Set(requests.map((request) => request.prompt_cache_key)).size).toBe(4);
    expect(memoryCalls[0]!.tools).toEqual(lead[0]!.tools);
    expect(memoryCalls[0]!.messages.slice(0, lead[2]!.messages.length)).toEqual(lead[2]!.messages);
    expect(JSON.stringify(memoryCalls[1]!.messages)).toContain("not available in this pass");
    for (let index = 1; index < memoryCalls.length; index += 1) {
      expect(memoryCalls[index]!.tools).toEqual(memoryCalls[0]!.tools);
      expect(
        memoryCalls[index]!.messages.slice(0, memoryCalls[index - 1]!.messages.length),
      ).toEqual(memoryCalls[index - 1]!.messages);
    }
  });
  it("sends canonical instance identities coherently through the real ChatGPT SDK and host adapter", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
    const host = createOpenAICodexAdapter({
      fetch: Object.assign(
        async (_input: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("expected serialized SDK body");
          requests.push({ headers: new Headers(init.headers), body: JSON.parse(init.body) });
          const item = {
            type: "message",
            id: "msg_fixture",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "Verified.", annotations: [] }],
          };
          const response = {
            id: "resp_fixture",
            model: "gpt-6-astra",
            created_at: 1,
            status: "completed",
            output: [item],
            usage: {
              input_tokens: 20000,
              output_tokens: 4,
              input_tokens_details: { cached_tokens: 0 },
            },
          };
          const events = [
            { type: "response.created", response },
            { type: "response.output_item.added", output_index: 0, item },
            {
              type: "response.output_text.delta",
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: "Verified.",
            },
            { type: "response.output_item.done", output_index: 0, item },
            { type: "response.completed", response },
          ];
          return new Response(
            events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    });
    const sdk = new AiSdkAdapter({
      resolveSubscription: async (scheme, _signal, context) => ({
        scheme,
        apply: (input, init) =>
          host.apply(
            subscriptionRegistration("openai-codex")!,
            {
              access_token: "synthetic",
              refresh_token: "synthetic",
              account_id: "fixture",
              expires_at: Number.MAX_SAFE_INTEGER,
            },
            input,
            init,
            context,
          ),
      }),
    });
    const identities = ["leader", "explorer-1", "explorer-2", "memory"];
    for (const agentInstanceId of identities) {
      const promptCacheKey = composePromptCacheKey({ sessionId: "session_1", agentInstanceId });
      for (let turn = 0; turn < 2; turn += 1) {
        const result = await sdk.call({
          provider: "chatgpt",
          providerConfig: { kind: "openai-codex" },
          model: "gpt-6-astra",
          reasoningEffort: "medium",
          promptCacheKey,
          messages: [{ role: "user", content: "Verify fixture." }],
          tools: [],
        });
        expect(result.text).toBe("Verified.");
      }
    }
    for (const request of requests) {
      const key = request.body.prompt_cache_key;
      if (typeof key !== "string") throw new Error("expected cache key");
      const affinity = createHash("sha256").update(key).digest("hex");
      expect(request.headers.get("session-id")).toBe(affinity);
      expect(request.headers.get("x-client-request-id")).toBe(affinity);
      expect(request.body).toMatchObject({
        stream: true,
        store: false,
        reasoning: { effort: "medium" },
      });
    }
    expect(new Set(requests.map((request) => request.body.prompt_cache_key)).size).toBe(4);
    expect(requests[0]!.body.prompt_cache_key).toBe(requests[1]!.body.prompt_cache_key);
  });
  it("retains plan publications, rejects historical CAS, and replays the persisted request after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-cache-composition-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    await mkdir(workspaceRoot);
    await mkdir(globalDir);
    const paths = globalPaths(globalDir);
    await writeFile(
      paths.settingsFile,
      JSON.stringify({
        default_model: "fixture/cache-model",
        providers: [
          { name: "fixture", kind: "openai-compatible", base_url: "https://fixture.invalid/v1" },
        ],
        runtime: { backend: "native" },
        plans: { mode: "on", pending_task_nudges: 0 },
      }),
    );
    await mkdir(paths.agentsDir);
    await writeFile(
      join(paths.agentsDir, "solo.md"),
      "---\ntools: []\ngrants: []\niteration_limit: 12\n---\nFollow the synthetic cursor.\n",
    );
    const store = createPlanStore({ repository: createInMemoryPlanRepository() });
    const requests: Array<{ messages: unknown[]; tools: unknown; prompt_cache_key: string }> = [];
    let initial: PlanDocument | undefined;
    const cas = (plan: PlanDocument) => ({
      expected_revision: plan.revision,
      expected_digest: plan.digest,
      expected_spec_digest: plan.spec_digest,
    });
    const transport = Object.assign(
      async (_input: string | URL | Request, init?: RequestInit) => {
        if (typeof init?.body !== "string") throw new Error("Expected serialized SDK request");
        requests.push(JSON.parse(init.body) as (typeof requests)[number]);
        const index = requests.length;
        let name: string | undefined;
        let args: Record<string, unknown> = {};
        if (index === 1) {
          name = "create_plan";
          args = {
            title: "Cursor",
            objective: "Complete the synthetic cursor",
            tasks: [{ title: "Read cursor" }],
            validation: [],
          };
        } else if (index === 2) {
          initial = (await store.list()).plans[0]!;
          name = "read_plan";
        } else if (index === 3) {
          await store.update(
            initial!.id,
            initial!,
            (plan) => {
              plan.objective = "Externally revised cursor";
            },
            { structural: true },
          );
          name = "transition_plan_task";
          args = {
            ...cas(initial!),
            transitions: [{ task_id: "t1", status: "done", result: "obsolete mutation" }],
          };
        } else if (index === 4 || index === 5) {
          const current = await store.read(initial!.id);
          name = "transition_plan_task";
          args = {
            ...cas(current),
            transitions: [
              {
                task_id: "t1",
                status: index === 4 ? "in_progress" : "done",
                ...(index === 5 ? { result: "cursor verified" } : {}),
              },
            ],
          };
        }
        const delta = name
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: `call-${index}`,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            }
          : { role: "assistant", content: "Cursor verified." };
        const chunk = {
          id: `response-${index}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "cache-model",
          choices: [{ index: 0, delta, finish_reason: name ? "tool_calls" : "stop" }],
          usage: {
            prompt_tokens: 20000 + index * 1000,
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    const adapter = new AiSdkAdapter({ fetch: transport });
    const open = async (): Promise<FileKernel> =>
      createFileKernel({
        workspaceRoot,
        globalDir,
        traceDir: join(root, "traces"),
        subscriptions: false,
        memory: false,
        planStoreFor: () => store,
        logger: NOOP_LOGGER,
        env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "0" }),
        builtins: { tools: false, hooks: false, tasks: false },
        executeRun: (args) => executeRun({ ...args, deps: { ...args.deps, llm: adapter } }),
      });
    let kernel = await open();
    cleanup.push(() => kernel.close());
    const first = await kernel.runs.start({
      agent: "solo",
      session_id: "cache-session",
      agent_instance_id: "leader-instance",
      messages: [{ role: "user", content: "Complete the cursor using the plan." }],
    });
    for await (const _event of first.events) {
      /* Drain the real kernel stream. */
    }
    expect((await first.done).status).toBe("completed");
    expect(requests).toHaveLength(6);
    const wire = JSON.stringify(requests[3]);
    expect(wire).toContain("obsolete mutation");
    expect(wire).toMatch(/conflict|stale|changed|mismatch/i);
    expect((await store.read(initial!.id)).tasks[0]?.result).toBe("cursor verified");
    await kernel.close();
    kernel = await open();
    const second = await kernel.runs.start({
      agent: "solo",
      continue_from: first.execution_id,
      messages: [{ role: "user", content: "Confirm the cursor in the next turn." }],
    });
    for await (const _event of second.events) {
      /* Drain the restored run. */
    }
    expect((await second.done).status).toBe("completed");
    expect(requests).toHaveLength(7);
    for (let index = 1; index < requests.length; index += 1) {
      expect(requests[index]!.prompt_cache_key).toBe("cache-session_leader-instance");
      expect(requests[index]!.tools).toEqual(requests[0]!.tools);
      expect(
        requests[index]!.messages.slice(0, requests[index - 1]!.messages.length),
        `request ${index + 1}`,
      ).toEqual(requests[index - 1]!.messages);
    }
  });
});
