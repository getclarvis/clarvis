import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  createGuestLoopExecutor,
  type GuestExecutionBridge,
  type RuntimeCheckpointInput,
} from "../../src/index.ts";
import { startGuestMain } from "../../src/runtime/guest-main.ts";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("runtime guest loop", () => {
  it("starts the image entrypoint only with both immutable identities", () => {
    const input = new PassThrough();
    const output = new PassThrough();
    expect(startGuestMain({ environment: {}, input, output })).toBeNull();
    const worker = startGuestMain({
      environment: {
        CLARVIS_RUNTIME_GENERATION: "generation-1",
        CLARVIS_RUNTIME_IMAGE_DIGEST: `sha256:${"a".repeat(64)}`,
      },
      input,
      output,
    });
    expect(worker).not.toBeNull();
    worker?.close();
  });

  it("runs the real loop through host model authority without inheriting host secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-guest-"));
    directories.push(root);
    const workspaceRoot = join(root, "workspace");
    const scratchRoot = join(root, "scratch");
    await mkdir(workspaceRoot);
    const modelBodies: unknown[] = [];
    const events: unknown[] = [];
    const checkpoints: Array<Omit<RuntimeCheckpointInput, "generation" | "runId">> = [];
    const records: unknown[] = [];
    process.env.CLARVIS_RUNTIME_HOST_SECRET = "must-not-cross";
    const bridge: GuestExecutionBridge = {
      async model(_callId, request) {
        modelBodies.push(request.body);
        return {
          events: [
            { type: "stream", channel: "text", text: "done", reset: true },
            {
              type: "result",
              result: {
                text: "done",
                usage: {
                  input_tokens: 10,
                  output_tokens: 2,
                  cached_tokens: 0,
                  cache_write_tokens: 0,
                },
              },
            },
          ],
          outputBytes: 128,
        };
      },
      async capability() {
        throw new Error("no host capability was granted");
      },
      async event(event) {
        events.push(event);
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { channel?: unknown }).channel === "trace_record"
        ) {
          records.push((event as { record?: unknown }).record);
        }
      },
      async checkpoint(checkpoint) {
        checkpoints.push(checkpoint);
      },
    };

    try {
      const outcome = await createGuestLoopExecutor({ workspaceRoot, scratchRoot }).execute(
        "exec_guest_1",
        {
          owner: "owner",
          modelLeaseId: "lease-1",
          rawBody: {
            execution_id: "exec_guest_1",
            messages: [{ role: "user", content: "hi" }],
            servers: [],
            profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
            entry: "solo",
            providers: [{ name: "anthropic", kind: "anthropic" }],
            budget: { on_exceed: "stop", total_token_limit: 1_000 },
          },
        },
        bridge,
        new AbortController().signal,
      );

      expect(outcome).toMatchObject({
        executionId: "exec_guest_1",
        response: { status: "completed" },
      });
      expect(events.length).toBeGreaterThan(0);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id: "exec_guest_1", owner_key_name: "owner" });
      expect(checkpoints).toEqual([{ sequence: 1, terminal: false, state: { outcome } }]);
      expect(JSON.stringify(modelBodies)).not.toContain("must-not-cross");
      expect(JSON.stringify(modelBodies)).toContain(workspaceRoot);
    } finally {
      delete process.env.CLARVIS_RUNTIME_HOST_SECRET;
    }
  });

  it("accepts the host plans request block and resolves its canonical provider", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-guest-plans-"));
    directories.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const calls: unknown[] = [];
    const bridge: GuestExecutionBridge = {
      async model() {
        return {
          events: [
            {
              type: "result",
              result: {
                text: "planned",
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cached_tokens: 0,
                  cache_write_tokens: 0,
                },
              },
            },
          ],
          outputBytes: 64,
        };
      },
      async capability(_callId, request) {
        calls.push(request);
        if (
          request.method === "runtime.plans" &&
          (request.arguments as { operation?: unknown }).operation === "resolve"
        ) {
          return { key: "markdown:host", providerKind: "markdown" };
        }
        throw new Error("unexpected host capability");
      },
      async event() {},
      async checkpoint() {},
    };

    await expect(
      createGuestLoopExecutor({ workspaceRoot, scratchRoot: join(root, "scratch") }).execute(
        "exec_guest_plans",
        {
          owner: "owner",
          modelLeaseId: "lease",
          hostCapabilities: ["plans"],
          rawBody: {
            execution_id: "exec_guest_plans",
            messages: [{ role: "user", content: "hi" }],
            servers: [],
            profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
            entry: "solo",
            providers: [{ name: "anthropic", kind: "anthropic" }],
            budget: { on_exceed: "stop", total_token_limit: 1_000 },
            plans: { mode: "on", retention: "keep", pending_task_nudges: 3 },
          },
        },
        bridge,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      executionId: "exec_guest_plans",
      response: { status: "completed", result: "planned" },
    });
    expect(calls).toEqual([
      {
        method: "runtime.plans",
        revision: "v1",
        arguments: { operation: "resolve" },
      },
    ]);
  });

  it("accepts use_skills and loads an admitted skill through host authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-guest-skills-"));
    directories.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const capabilityCalls: unknown[] = [];
    const modelBodies: unknown[] = [];
    let modelCall = 0;
    const bridge: GuestExecutionBridge = {
      async model(_callId, request) {
        modelCall += 1;
        modelBodies.push(request.body);
        return {
          events: [
            {
              type: "result",
              result:
                modelCall === 1
                  ? {
                      toolCalls: [
                        {
                          id: "load-skill-1",
                          name: "load_skill",
                          arguments: { name: "container-review" },
                        },
                      ],
                      usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                        cached_tokens: 0,
                        cache_write_tokens: 0,
                      },
                    }
                  : {
                      text: "skill loaded",
                      usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                        cached_tokens: 0,
                        cache_write_tokens: 0,
                      },
                    },
            },
          ],
          outputBytes: 128,
        };
      },
      async capability(_callId, request) {
        capabilityCalls.push(request);
        return {
          kind: "skill",
          name: "container-review",
          description: "Review a container change",
          body: "Inspect the proposed change.",
          directory: "/runtime/skills/container-review",
          resources: [],
        };
      },
      async event() {},
      async checkpoint() {},
    };

    await expect(
      createGuestLoopExecutor({ workspaceRoot, scratchRoot: join(root, "scratch") }).execute(
        "exec_guest_skills",
        {
          owner: "owner",
          modelLeaseId: "lease",
          hostCapabilities: ["skills"],
          skillCatalog: [
            {
              name: "container-review",
              description: "Review a container change",
              scope: "user",
              source: "runtime",
            },
          ],
          rawBody: {
            execution_id: "exec_guest_skills",
            messages: [{ role: "user", content: "review it" }],
            servers: [],
            profiles: [
              {
                name: "solo",
                model: "anthropic/x",
                tools: [],
                grants: ["use_skills"],
                iteration_limit: 3,
              },
            ],
            entry: "solo",
            providers: [{ name: "anthropic", kind: "anthropic" }],
            budget: { on_exceed: "stop", total_token_limit: 1_000 },
          },
        },
        bridge,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      executionId: "exec_guest_skills",
      response: { status: "completed", result: "skill loaded" },
    });
    expect(JSON.stringify(modelBodies[0])).toContain("/runtime/skills/container-review/SKILL.md");
    expect(capabilityCalls).toEqual([
      {
        method: "runtime.skills",
        revision: "v1",
        arguments: { operation: "load", name: "container-review" },
      },
    ]);
  });

  it("routes ask_user through the exact host capability and refuses a missing model result", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-guest-elicit-"));
    directories.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    let modelCall = 0;
    const bridge: GuestExecutionBridge = {
      async model() {
        modelCall += 1;
        return {
          events: [
            {
              type: "result",
              result:
                modelCall === 1
                  ? {
                      toolCalls: [
                        { id: "ask-1", name: "ask_user", arguments: { question: "Continue?" } },
                      ],
                      usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                        cached_tokens: 0,
                        cache_write_tokens: 0,
                      },
                    }
                  : {
                      text: "done",
                      usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                        cached_tokens: 0,
                        cache_write_tokens: 0,
                      },
                    },
            },
          ],
          outputBytes: 64,
        };
      },
      async capability(_callId, request) {
        expect(request).toMatchObject({ method: "runtime.elicit", revision: "v1" });
        return { action: "accept", content: { response: "yes" } };
      },
      async event() {},
      async checkpoint() {},
    };
    const body = {
      execution_id: "exec_guest_elicit",
      messages: [{ role: "user", content: "hi" }],
      servers: [],
      profiles: [
        {
          name: "solo",
          model: "anthropic/x",
          tools: [],
          grants: ["ask_user"],
          iteration_limit: 3,
        },
      ],
      entry: "solo",
      providers: [{ name: "anthropic", kind: "anthropic" }],
      budget: { on_exceed: "stop", total_token_limit: 1_000 },
    };
    await expect(
      createGuestLoopExecutor({ workspaceRoot, scratchRoot: join(root, "scratch") }).execute(
        "exec_guest_elicit",
        { owner: "owner", modelLeaseId: "lease", rawBody: body },
        bridge,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ executionId: "exec_guest_elicit" });
    const missingResult = { ...bridge, model: async () => ({ events: [], outputBytes: 0 }) };
    await expect(
      createGuestLoopExecutor({ workspaceRoot, scratchRoot: join(root, "scratch-2") }).execute(
        "exec_guest_missing",
        {
          owner: "owner",
          modelLeaseId: "lease",
          rawBody: { ...body, execution_id: "exec_guest_missing" },
        },
        missingResult,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      response: {
        status: "error",
        error: { message: "host model broker returned no terminal model result" },
      },
    });
  });

  it("guards guest shell execution and exposes a granted service through host authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-guest-preview-"));
    directories.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    let modelCall = 0;
    const modelBodies: unknown[] = [];
    const capabilities: unknown[] = [];
    const events: unknown[] = [];
    const bridge: GuestExecutionBridge = {
      async model(_callId, request) {
        modelCall += 1;
        modelBodies.push(request.body);
        const result =
          modelCall === 1
            ? {
                toolCalls: [
                  {
                    id: "shell-1",
                    name: "shell",
                    arguments: { command: "printf guest-shell" },
                  },
                ],
              }
            : modelCall === 2
              ? {
                  toolCalls: [
                    {
                      id: "preview-1",
                      name: "expose_port",
                      arguments: { port: 9090 },
                    },
                  ],
                }
              : { text: "preview ready" };
        return {
          events: [
            {
              type: "result",
              result: {
                ...result,
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  cached_tokens: 0,
                  cache_write_tokens: 0,
                },
              },
            },
          ],
          outputBytes: 128,
        };
      },
      async capability(_callId, request) {
        capabilities.push(request);
        if (request.method !== "runtime.preview") throw new Error("unexpected capability");
        return {
          guestPort: 9090,
          host: "127.0.0.1",
          hostPort: 19_090,
          protocol: "http",
          url: "http://127.0.0.1:19090/",
        };
      },
      async event(event) {
        events.push(event);
      },
      async checkpoint() {},
    };
    await expect(
      createGuestLoopExecutor({ workspaceRoot, scratchRoot: join(root, "scratch") }).execute(
        "exec_guest_preview",
        {
          owner: "owner",
          modelLeaseId: "lease",
          guardSettings: {
            guard: { type: "shell", mode: "on", allowed_commands: ["printf"] },
          },
          rawBody: {
            execution_id: "exec_guest_preview",
            messages: [{ role: "user", content: "start a service" }],
            servers: [],
            profiles: [
              {
                name: "solo",
                model: "anthropic/x",
                tools: [],
                grants: ["run_commands"],
                iteration_limit: 5,
              },
            ],
            entry: "solo",
            providers: [{ name: "anthropic", kind: "anthropic" }],
            budget: { on_exceed: "stop", total_token_limit: 1_000 },
          },
        },
        bridge,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      response: { status: "completed", result: "preview ready" },
    });
    expect(capabilities).toEqual([
      {
        method: "runtime.preview",
        revision: "v1",
        arguments: { port: 9090 },
      },
    ]);
    expect(JSON.stringify(modelBodies)).toContain("mise x <tool>@<version>");
    expect(events).toContainEqual({
      channel: "guard_audit",
      level: "info",
      fields: expect.objectContaining({
        event: "guard.decision",
        verdict: "allow",
        tool: "shell",
      }),
    });
  });
});
