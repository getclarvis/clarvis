import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { createFilePlanRepository, createPlanStore } from "@clarvis/plan";
import { globalPaths, localHostPaths, writeFileDurableSync } from "@clarvis/paths";
import { createFileRunHost, type FileRunHostOptions } from "../../src/bootstrap.ts";
import { openHostedProjection } from "../../src/hosting/projection.ts";
import { createKernelEnvironment } from "../../src/ports/environment.ts";
import type { RuntimeSettingsInput } from "../../src/runtime/settings.ts";
import { connectKernelClient } from "../../src/transport/client.ts";
import { connectLocalKernelTransport, listenLocalKernel } from "../../src/transport/local.ts";

export interface GoalFixtureRequest {
  messages: Array<Record<string, unknown>>;
  tools?: Array<{ function: { name: string } }>;
  prompt_cache_key: string;
  stream?: boolean;
}

export type GoalFixtureResponse = (
  { text: string } | { name: string; arguments: Record<string, unknown> }
) & { usage?: "missing" | "no_cache" };

/** Real file host, IPC, provider HTTP and SDK; only the provider's responses are controlled. */
export async function createGoalFileHostFixture(
  options: {
    runtime?: RuntimeSettingsInput;
    runtimeFactory?: FileRunHostOptions["kernel"]["runtimeFactory"];
    timeoutMs?: number;
    plansMode?: "off" | "on" | "review";
    planRetention?: "keep" | "discard";
    memory?: boolean;
    preserveRecentTokens?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "clarvis-goal-file-host-"));
  const cleanups: Array<() => Promise<unknown>> = [
    () => rm(root, { recursive: true, force: true }),
  ];
  const close = async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Goal file host cleanup failed");
  };
  try {
    const workspaceRoot = join(root, "workspace");
    const globalDir = join(root, "global");
    await mkdir(workspaceRoot);
    await mkdir(globalDir);
    const planStore = createPlanStore({
      repository: createFilePlanRepository({ workspaceRoot, lockDir: join(root, "plan-locks") }),
    });
    const requests: GoalFixtureRequest[] = [];
    const usages: Array<{ input: number; output: number; cached: number }> = [];
    const errors: string[] = [];
    let respond: (request: GoalFixtureRequest) => Promise<GoalFixtureResponse> = async () => {
      throw new Error("Goal fixture responder was not installed");
    };
    const started = performance.now();
    const timeoutMs = options.timeoutMs ?? 30000;
    const provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 60,
      async fetch(request) {
        try {
          const body = (await request.json()) as GoalFixtureRequest;
          requests.push(body);
          if (requests.length > 24 || performance.now() - started > timeoutMs)
            throw new Error("Goal fixture physical-call or duration limit exceeded");
          const index = requests.length;
          const result = await respond(body);
          const usage = { input: 1000 + index * 10, output: 10, cached: 500 };
          if (result.usage !== "missing") usages.push(usage);
          const chunk = {
            id: `response-${index}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "model",
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  ...("text" in result
                    ? { content: result.text }
                    : {
                        tool_calls: [
                          {
                            index: 0,
                            id: `call-${index}`,
                            type: "function",
                            function: {
                              name: result.name,
                              arguments: JSON.stringify(result.arguments),
                            },
                          },
                        ],
                      }),
                },
                finish_reason: "text" in result ? "stop" : "tool_calls",
              },
            ],
            ...(result.usage === "missing"
              ? {}
              : {
                  usage: {
                    prompt_tokens: usage.input,
                    completion_tokens: usage.output,
                    total_tokens: usage.input + usage.output,
                    ...(result.usage === "no_cache"
                      ? {}
                      : { prompt_tokens_details: { cached_tokens: usage.cached } }),
                  },
                }),
          };
          if (body.stream !== true)
            return Response.json({
              ...chunk,
              object: "chat.completion",
              choices: chunk.choices.map(({ index, delta, finish_reason }) => ({
                index,
                message: delta,
                finish_reason,
              })),
            });
          return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        } catch (error) {
          errors.push(String(error));
          return Response.json(
            { error: { message: "Controlled fixture failed" } },
            { status: 400 },
          );
        }
      },
    });
    cleanups.push(() => Promise.resolve(provider.stop(true)));
    const global = globalPaths(globalDir);
    await writeFile(
      global.settingsFile,
      JSON.stringify({
        default_model: "fixture/model",
        providers: [
          {
            name: "fixture",
            kind: "openai-compatible",
            base_url: `http://127.0.0.1:${String(provider.port)}/v1`,
          },
        ],
        runtime: options.runtime ?? { backend: "native" },
        plans: { mode: options.plansMode ?? "on", retention: options.planRetention ?? "keep" },
        ...(options.memory === true ? { memory: { enabled: true } } : {}),
        guard: { type: "shell", mode: "off" },
      }),
    );
    await mkdir(global.agentsDir);
    for (const profile of ["solo", "helper"]) {
      await writeFile(
        join(global.agentsDir, `${profile}.md`),
        [
          "---",
          "tools: []",
          "grants: [read_workspace, edit_workspace, run_commands]",
          "iteration_limit: 12",
          "retry: {max_retries: 0}",
          ...(profile === "solo" ? ["can_spawn: [helper]"] : []),
          "---",
          "Complete the controlled synthetic fixture through the supplied tools.",
        ].join("\n"),
      );
    }
    const paths = localHostPaths({
      globalDir,
      workspaceRoot,
      owner: "operator",
      operatorId: "test",
    });
    await mkdir(paths.root, { recursive: true, mode: 0o700 });
    if (paths.endpointDirectory !== undefined) {
      const directory = paths.endpointDirectory;
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
    }
    const host = await createFileRunHost({
      kernel: {
        workspaceRoot,
        globalDir,
        defaultOwner: "operator",
        subscriptions: false,
        memory: options.memory ?? false,
        logger: NOOP_LOGGER,
        env: loadEnv({
          CLARVIS_LOG_LEVEL: "silent",
          CLARVIS_AGENT_TOOLS_MAX_GRANT: "exec",
          ...(options.preserveRecentTokens === undefined
            ? {}
            : {
                CLARVIS_DEFAULT_COMPACTION_PRESERVE_RECENT_TOKENS: String(
                  options.preserveRecentTokens,
                ),
              }),
        }),
        environment: createKernelEnvironment({ PATH: process.env.PATH }),
        builtins: { tools: true, skills: false, hooks: false, tasks: false },
        planStoreFor: () => planStore,
        ...(options.runtimeFactory === undefined ? {} : { runtimeFactory: options.runtimeFactory }),
      },
      hostGeneration: "generation",
      authenticate: (token) => (token === "operator-token" ? "operator" : undefined),
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
    const transport = await connectLocalKernelTransport(paths.endpoint);
    cleanups.push(() => transport.close());
    const client = await connectKernelClient(transport, { auth: "operator-token" });
    await client.sessions.save({
      id: "conversation",
      title: "Goal fixture",
      project_id: client.project.id,
      workspace: client.workspace.id,
      created_at: 1,
      updated_at: 1,
      turns: [],
      totals: { input: 0, output: 0, cached: 0 },
      agent_profile: "solo",
    });
    return {
      root,
      workspaceRoot,
      client,
      host,
      planStore,
      requests,
      usages,
      errors,
      close,
      setResponder(value: typeof respond) {
        respond = value;
      },
      async until(predicate: () => boolean | Promise<boolean>) {
        const deadline = performance.now() + timeoutMs;
        while (!(await predicate())) {
          if (errors.length > 0 || performance.now() > deadline) {
            const view = await client.goals.get("conversation");
            throw new Error(`Goal file host did not settle: ${JSON.stringify({ errors, view })}`);
          }
          await Bun.sleep(5);
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
