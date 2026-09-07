import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { ValidationError } from "@clarvis/capability";
import { MEMORY_READ_TOOL_NAMES, MEMORY_WRITE_TOOL_NAMES } from "@clarvis/memory/capability";
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
  it.each([{ servers: {} }, { servers: [null] }])(
    "retains request validation and closes MCP hooks for malformed servers %j",
    async ({ servers }) => {
      const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-invalid-mcp-"));
      directories.push(root);
      const executor = createGuestLoopExecutor({
        workspaceRoot: root,
        scratchRoot: join(root, "scratch"),
      });
      const bridge: GuestExecutionBridge = {
        model: async () => {
          throw new Error("invalid requests must not call the model");
        },
        capability: async () => {
          throw new Error("invalid requests must not invoke hooks");
        },
        event: async () => undefined,
        checkpoint: async () => undefined,
      };
      const signal = new AbortController().signal;
      await expect(
        executor.execute(
          "invalid-mcp",
          {
            owner: "owner",
            modelLeaseId: "lease",
            rawBody: {
              execution_id: "invalid-mcp",
              servers,
              messages: [{ role: "user", content: "hi" }],
              providers: [{ name: "test", kind: "anthropic" }],
              profiles: [{ name: "solo", model: "test/model", tools: [], iteration_limit: 3 }],
              entry: "solo",
              budget: { on_exceed: "stop", total_token_limit: 1_000 },
            },
          },
          bridge,
          signal,
        ),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        executor.callHookMcp!(
          "invalid-mcp",
          { server: "review", tool: "inspect", input: {} },
          signal,
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(executor.elicitMcp!("invalid-mcp", {}, signal)).rejects.toMatchObject({
        code: "not_found",
      });
    },
  );

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
    const guestEvents: unknown[] = [];
    let markFirstModelStarted!: () => void;
    const firstModelStarted = new Promise<void>((resolve) => {
      markFirstModelStarted = resolve;
    });
    let releaseFirstModel!: () => void;
    const firstModelGate = new Promise<void>((resolve) => {
      releaseFirstModel = resolve;
    });
    let modelCall = 0;
    const bridge: GuestExecutionBridge = {
      async model(_callId, request) {
        modelCall += 1;
        modelBodies.push(request.body);
        if (modelCall === 1) {
          markFirstModelStarted();
          await firstModelGate;
        }
        return {
          events: [
            {
              type: "result",
              result:
                modelCall === 1
                  ? {
                      toolCalls: [
                        {
                          id: "invalid-load-skill",
                          name: "load_skill",
                          arguments: {
                            name: "container-review",
                            resource: "/dev/null? no resource omitted actually.",
                          },
                        },
                      ],
                      usage: {
                        input_tokens: 1,
                        output_tokens: 1,
                        cached_tokens: 0,
                        cache_write_tokens: 0,
                      },
                    }
                  : modelCall === 2
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
      async event(event) {
        guestEvents.push(event);
      },
      async checkpoint() {},
    };

    const executor = createGuestLoopExecutor({
      workspaceRoot,
      scratchRoot: join(root, "scratch"),
    });
    const run = executor.execute(
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
              iteration_limit: 4,
            },
          ],
          entry: "solo",
          providers: [{ name: "anthropic", kind: "anthropic" }],
          budget: { on_exceed: "stop", total_token_limit: 1_000 },
        },
      },
      bridge,
      new AbortController().signal,
    );
    await firstModelStarted;
    await expect(
      executor.steer!(
        "exec_guest_skills",
        {
          kind: "steer",
          message: { content: "Also verify the strict contract." },
          unexpected: true,
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      executor.steer!(
        "exec_guest_skills",
        { kind: "compact", request: {} },
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    const steer = executor.steer!(
      "exec_guest_skills",
      { kind: "steer", message: { content: "Also verify the strict contract." } },
      new AbortController().signal,
    );
    const stillQueued = Promise.resolve("queued");
    await expect(Promise.race([steer.then(() => "drained"), stillQueued])).resolves.toBe("queued");
    releaseFirstModel();
    await expect(steer).resolves.toBeUndefined();
    await expect(run).resolves.toMatchObject({
      executionId: "exec_guest_skills",
      response: { status: "completed", result: "skill loaded" },
    });
    await expect(
      executor.steer!(
        "exec_guest_skills",
        { kind: "steer", message: { content: "late" } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(JSON.stringify(modelBodies[0])).toContain("/runtime/skills/container-review/SKILL.md");
    expect(JSON.stringify(modelBodies[1])).toContain("Also verify the strict contract.");
    expect(JSON.stringify(modelBodies[1])).toContain("InputValidationError");
    expect(JSON.stringify(guestEvents)).toContain("compaction_started");
    const firstTools = (
      modelBodies[0] as { tools: Array<{ wireName: string; inputSchema: unknown }> }
    ).tools;
    expect(firstTools.map((tool) => tool.wireName)).toContain("read_skill_resource");
    expect(firstTools.find((tool) => tool.wireName === "load_skill")?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["name"],
      properties: { name: expect.anything() },
    });
    expect(
      Object.keys(
        (
          firstTools.find((tool) => tool.wireName === "load_skill")?.inputSchema as {
            properties: Record<string, unknown>;
          }
        ).properties,
      ),
    ).toEqual(["name"]);
    expect(capabilityCalls).toEqual([
      {
        method: "runtime.skills",
        revision: "v1",
        arguments: { operation: "load", name: "container-review" },
      },
    ]);
  });

  it("projects host memory into the prompt, proxies tools, and finalizes after host persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-runtime-guest-memory-"));
    directories.push(root);
    const workspaceRoot = join(root, "workspace");
    await mkdir(workspaceRoot);
    const capabilityCalls: unknown[] = [];
    const modelBodies: unknown[] = [];
    let tracePersisted = false;
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
                          id: "read-memory-1",
                          name: "read_memory",
                          arguments: { paths: ["PROFILE.md"] },
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
                      text: "memory loaded",
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
        const args = request.arguments as { operation?: unknown };
        if (args.operation === "seed") return { kind: "seed", value: "HOST_MEMORY_SEED" };
        if (args.operation === "call") {
          return { kind: "result", text: "HOST_MEMORY_DOCUMENT", isError: false };
        }
        if (args.operation === "finish") {
          expect(tracePersisted).toBe(true);
          return { kind: "finished" };
        }
        throw new Error("unexpected memory operation");
      },
      async event(event) {
        if (
          typeof event === "object" &&
          event !== null &&
          (event as { channel?: unknown }).channel === "trace_record"
        ) {
          tracePersisted = true;
        }
      },
      async checkpoint() {},
    };

    await expect(
      createGuestLoopExecutor({ workspaceRoot, scratchRoot: join(root, "scratch") }).execute(
        "exec_guest_memory",
        {
          owner: "owner",
          modelLeaseId: "lease",
          hostCapabilities: ["memory"],
          memory: {
            providerDigest: "a".repeat(64),
            seedMaxChars: 6_000,
            readTools: ["list_memories", "read_memory", "grep_memories", "query_memories"],
          },
          rawBody: {
            execution_id: "exec_guest_memory",
            messages: [{ role: "user", content: "use memory" }],
            servers: [],
            profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
            entry: "solo",
            providers: [{ name: "anthropic", kind: "anthropic" }],
            memory: "on",
            budget: { on_exceed: "stop", total_token_limit: 1_000 },
          },
        },
        bridge,
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      executionId: "exec_guest_memory",
      response: { status: "completed", result: "memory loaded" },
    });
    expect(JSON.stringify(modelBodies[0])).toContain("HOST_MEMORY_SEED");
    expect(JSON.stringify(modelBodies[0])).toContain("## Memory");
    expect(JSON.stringify(modelBodies[0])).toContain("read_memory");
    expect(JSON.stringify(modelBodies[0])).not.toContain("write_memory");
    const guestToolNames = (modelBodies[0] as { tools: Array<{ wireName: string }> }).tools.map(
      (tool) => tool.wireName,
    );
    for (const name of MEMORY_READ_TOOL_NAMES) expect(guestToolNames).toContain(name);
    for (const name of MEMORY_WRITE_TOOL_NAMES) expect(guestToolNames).not.toContain(name);
    expect(JSON.stringify(modelBodies[1])).toContain("HOST_MEMORY_DOCUMENT");
    expect(
      capabilityCalls.map(
        (request) => (request as { arguments: { operation: string } }).arguments.operation,
      ),
    ).toEqual(["seed", "call", "finish"]);
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
