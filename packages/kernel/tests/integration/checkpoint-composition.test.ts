import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, NOOP_LOGGER, type Capability } from "@clarvis/capability";
import { executeRun } from "@clarvis/loop";
import { AiSdkAdapter } from "@clarvis/llm/adapter";
import { createFilePlanRepository, createPlanStore, type PlanDocument } from "@clarvis/plan";
import { globalPaths } from "@clarvis/paths";
import type { RunEvent } from "@clarvis/protocol";
import { createFileKernel, type FileKernel } from "../../src/file-kernel.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

const checkpoint = { summary: "Plan prepared", next_step: "Verify the synthetic result" };
const boundary: Capability = {
  name: "checkpoint-fixture",
  required: true,
  forRun: () => ({
    name: "checkpoint-fixture",
    preserveStateOnInterruption: true,
    forAgent: (scope) =>
      scope.entry
        ? {
            attach: () => ({
              advertised: true,
              tools: [
                {
                  fullName: "checkpoint_stage",
                  wireName: "checkpoint_stage",
                  mcpName: "",
                  toolName: "checkpoint_stage",
                  description: "Hand the stage back to the host for continuation.",
                  inputSchema: { type: "object", properties: {}, additionalProperties: false },
                },
              ],
              handlers: [
                {
                  matches: (call) => call.name === "checkpoint_stage",
                  handle: async () => ({
                    kind: "finalize",
                    text: "Stage handoff requested",
                    progress: false,
                    attempt: { mode: "checkpoint", disposition: "checkpoint", checkpoint },
                  }),
                },
              ],
            }),
          }
        : null,
  }),
};

describe("checkpoint composition", () => {
  it("preserves an open discard plan and serialized history across kernel reopen, then validates the final output and applies retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-checkpoint-composition-"));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    await mkdir(workspaceRoot);
    await mkdir(globalDir);
    const paths = globalPaths(globalDir);
    await writeFile(
      paths.settingsFile,
      JSON.stringify({
        default_model: "fixture/model",
        providers: [
          { name: "fixture", kind: "openai-compatible", base_url: "https://fixture.invalid/v1" },
        ],
        runtime: { backend: "native" },
        plans: { mode: "on", pending_task_nudges: 3, retention: "discard" },
      }),
    );
    await mkdir(paths.agentsDir);
    await writeFile(
      join(paths.agentsDir, "solo.md"),
      "---\ntools: []\ngrants: []\niteration_limit: 8\n---\nFollow the synthetic stage.\n",
    );
    const openStore = () =>
      createPlanStore({
        repository: createFilePlanRepository({ workspaceRoot, lockDir: join(root, "plan-locks") }),
      });
    let store = openStore();
    const requests: Array<{ messages: unknown[]; tools: unknown; prompt_cache_key: string }> = [];
    let initial: PlanDocument;
    const adapter = new AiSdkAdapter({
      fetch: Object.assign(
        async (_input: string | URL | Request, init?: RequestInit) => {
          if (typeof init?.body !== "string") throw new Error("Expected serialized SDK request");
          requests.push(JSON.parse(init.body) as (typeof requests)[number]);
          const step = requests.length;
          let name: string;
          let args: Record<string, unknown> = {};
          switch (step) {
            case 1:
              name = "create_plan";
              args = {
                title: "Synthetic stage",
                objective: "Verify the fixture",
                tasks: [{ title: "Verify" }],
                validation: [],
              };
              break;
            case 2:
              initial = (await store.list()).plans[0]!;
              name = "checkpoint_stage";
              break;
            case 3:
              name = "read_plan";
              break;
            case 4: {
              const plan = await store.read(initial.id);
              name = "transition_plan_task";
              args = {
                expected_revision: plan.revision,
                expected_digest: plan.digest,
                expected_spec_digest: plan.spec_digest,
                transitions: [
                  { task_id: "t1", status: "done", result: "Synthetic fixture verified" },
                ],
              };
              break;
            }
            default:
              name = "submit_result";
              args = { verified: true };
          }
          const chunk = {
            id: `response-${step}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "model",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call-${step}`,
                      type: "function",
                      function: { name, arguments: JSON.stringify(args) },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: {
              prompt_tokens: 1000 + step * 10,
              completion_tokens: 10,
              prompt_tokens_details: { cached_tokens: 0 },
            },
          };
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        },
        { preconnect: globalThis.fetch.preconnect },
      ),
    });
    const open = (): Promise<FileKernel> =>
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
        executeRun: (args) =>
          executeRun({
            ...args,
            deps: {
              ...args.deps,
              llm: adapter,
              capabilities: [...(args.deps.capabilities ?? []), boundary],
            },
          }),
      });
    let kernel = await open();
    cleanup.push(() => kernel.close());
    const output_schema = {
      type: "object",
      properties: { verified: { type: "boolean" } },
      required: ["verified"],
      additionalProperties: false,
    };
    const first = await kernel.runs.start({
      agent: "solo",
      session_id: "stage-session",
      agent_instance_id: "stage-leader",
      output_schema,
      messages: [{ role: "user", content: "Prepare the plan and hand off the stage." }],
    });
    const liveEvents: RunEvent[] = [];
    for await (const event of first.events) liveEvents.push(event);
    const liveEnded = liveEvents.find((event) => event.type === "run_ended");
    expect(liveEnded).toMatchObject({ status: "completed", disposition: "checkpoint" });
    expect(await first.done).toMatchObject({
      status: "completed",
      disposition: "checkpoint",
      checkpoint,
    });
    expect((await first.done).result).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(await store.read(initial!.id)).toEqual(initial!);
    expect(initial!.tasks[0]!.status).toBe("pending");
    const firstDetail = await kernel.runs.get(first.execution_id);
    expect(firstDetail.plan_ref?.status).not.toBe("completed");
    await kernel.close();
    store = openStore();
    kernel = await open();
    const restored = await kernel.runs.get(first.execution_id);
    expect(restored.events.find((event) => event.type === "run_ended")).toEqual(liveEnded);
    expect(restored.result).toMatchObject({
      disposition: "checkpoint",
      checkpoint,
    });
    const second = await kernel.runs.start({
      agent: "solo",
      continue_from: first.execution_id,
      output_schema,
      messages: [{ role: "user", content: "Continue and verify the fixture." }],
    });
    for await (const event of second.events) void event;
    expect(await second.done).toMatchObject({ status: "completed", result: { verified: true } });
    expect((await second.done).checkpoint).toBeUndefined();
    const final = await kernel.runs.get(second.execution_id);
    expect(final.plan_ref).toMatchObject({
      id: initial!.id,
      status: "completed",
      retention: "discard",
    });
    expect((await store.list()).plans).toHaveLength(0);
    expect(requests).toHaveLength(5);
    expect(new Set(requests.map((request) => request.prompt_cache_key))).toEqual(
      new Set(["stage-session_stage-leader"]),
    );
    for (let i = 1; i < requests.length; i++) {
      const previous = requests[i - 1]!;
      expect(requests[i]!.tools).toEqual(previous.tools);
      expect(requests[i]!.messages.slice(0, previous.messages.length)).toEqual(previous.messages);
    }
  });
});
