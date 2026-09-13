import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { loadEnv } from "@clarvis/capability";
import { runtimeLoopPolicy } from "../../src/runtime/loop-policy.ts";
import {
  createGuestLoopExecutor,
  type GuestExecutionBridge,
  type RuntimeCheckpointInput,
} from "../../src/index.ts";
import { startGuestMain } from "../../src/runtime/guest-main.ts";
import { isGuestControlInput } from "../../src/runtime/guest-loop-executor.ts";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("runtime guest loop", () => {
  it("closes steer and compact control payloads without rejecting supported message content", () => {
    for (const valid of [
      { kind: "steer", message: { content: "continue" } },
      { kind: "steer", message: { id: "message-1", content: [{ type: "text", text: "hi" }] } },
      {
        kind: "steer",
        message: {
          content: [
            { type: "image", image: "aGVsbG8=", mediaType: "image/png" },
            { type: "image", image: "aGVsbG8=" },
          ],
        },
      },
      { kind: "compact", request: {} },
      { kind: "compact", request: { request: "preserve failures" } },
    ]) {
      expect(isGuestControlInput(valid)).toBe(true);
    }
    for (const invalid of [
      null,
      [],
      { kind: "other" },
      { kind: "steer", message: null },
      { kind: "steer", message: { content: 1 } },
      { kind: "steer", message: { content: [null] } },
      { kind: "steer", message: { content: [{ type: "text" }] } },
      { kind: "steer", message: { content: [{ type: "image", image: 1 }] } },
      {
        kind: "steer",
        message: { content: [{ type: "image", image: "aGVsbG8=", mediaType: 1 }] },
      },
      { kind: "steer", message: { content: "hi", id: 1 } },
      { kind: "steer", message: { content: "hi", extra: true } },
      { kind: "compact", request: null },
      { kind: "compact", request: { request: 1 } },
      { kind: "compact", request: { request: "now", extra: true } },
    ]) {
      expect(isGuestControlInput(invalid)).toBe(false);
    }
  });

  it("rejects malformed interrupt payloads and reports not_running for unknown runs", async () => {
    const executor = createGuestLoopExecutor();
    await expect(executor.interruptTool?.("missing", {})).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      executor.interruptTool?.("missing", { tool_execution_id: "tok_shell" }),
    ).resolves.toEqual({ tool_execution_id: "tok_shell", status: "not_running" });
  });

  it.each([
    undefined,
    null,
    { enabled: true, maxGrant: "exec" },
    { enabled: 1, confine: true, maxGrant: "exec" },
    { enabled: true, confine: true, maxGrant: "root" },
    { enabled: true, confine: true, maxGrant: "exec", extra: true },
  ])("refuses a missing or widened host tool policy %j", async (toolPolicy) => {
    const executor = createGuestLoopExecutor();
    await expect(
      executor.execute(
        "invalid-policy",
        {
          owner: "owner",
          modelLeaseId: "lease",
          rawBody: {},
          toolPolicy,
          loopPolicy: runtimeLoopPolicy(loadEnv({})),
        },
        {
          model: async () => {
            throw new Error("must not call model");
          },
          capability: async () => {
            throw new Error("must not invoke host authority");
          },
          event: async () => {},
          checkpoint: async () => {},
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("guest run envelope is invalid");
  });

  it.each([
    "hostCapabilities",
    "skillCatalog",
    "skillBootstraps",
    "memory",
    "hooks",
    "workflow",
    "goal",
    "parentRunId",
    "outputBudgets",
  ])("rejects obsolete feature envelope field %s", async (field) => {
    const executor = createGuestLoopExecutor();
    await expect(
      executor.execute(
        "invalid-feature-envelope",
        {
          owner: "owner",
          modelLeaseId: "lease",
          rawBody: {},
          toolPolicy: { enabled: true, confine: true, maxGrant: "exec" },
          loopPolicy: runtimeLoopPolicy(loadEnv({})),
          [field]: field === "outputBudgets" ? [] : {},
        },
        {
          model: async () => {
            throw new Error("must not call model");
          },
          capability: async () => {
            throw new Error("must not invoke host authority");
          },
          event: async () => {},
          checkpoint: async () => {},
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("guest run envelope is invalid");
  });

  it.each(["plans", "memory", "task", "skill", "guard_mode", "guard_judge"])(
    "rejects obsolete feature request field %s before execution",
    async (field) => {
      const executor = createGuestLoopExecutor();
      await expect(
        executor.execute(
          "invalid-feature-request",
          {
            owner: "owner",
            modelLeaseId: "lease",
            rawBody: {
              execution_id: "invalid-feature-request",
              messages: [{ role: "user", content: "hi" }],
              servers: [],
              profiles: [{ name: "solo", model: "main/model", tools: [] }],
              providers: [
                {
                  name: "main",
                  kind: "openai-compatible",
                  base_url: "http://runtime-model-broker.invalid",
                },
              ],
              entry: "solo",
              [field]: "forged",
            },
            toolPolicy: { enabled: true, confine: true, maxGrant: "exec" },
            loopPolicy: runtimeLoopPolicy(loadEnv({})),
          },
          {
            model: async () => {
              throw new Error("must not call model");
            },
            capability: async () => {
              throw new Error("must not invoke host authority");
            },
            event: async () => {},
            checkpoint: async () => {},
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow("guest run envelope is invalid");
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
          toolPolicy: { enabled: true, maxGrant: "exec", confine: true },
          loopPolicy: runtimeLoopPolicy(loadEnv({})),
          rawBody: {
            execution_id: "exec_guest_1",
            messages: [{ role: "user", content: "hi" }],
            servers: [],
            profiles: [{ name: "solo", model: "anthropic/x", tools: [], iteration_limit: 3 }],
            entry: "solo",
            providers: [
              {
                name: "anthropic",
                kind: "openai-compatible",
                base_url: "http://runtime-model-broker.invalid",
              },
            ],
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
      providers: [
        {
          name: "anthropic",
          kind: "openai-compatible",
          base_url: "http://runtime-model-broker.invalid",
        },
      ],
      budget: { on_exceed: "stop", total_token_limit: 1_000 },
    };
    await expect(
      createGuestLoopExecutor({ workspaceRoot, scratchRoot: join(root, "scratch") }).execute(
        "exec_guest_elicit",
        {
          owner: "owner",
          modelLeaseId: "lease",
          toolPolicy: { enabled: true, maxGrant: "exec", confine: true },
          loopPolicy: runtimeLoopPolicy(loadEnv({})),
          rawBody: body,
        },
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
          toolPolicy: { enabled: true, maxGrant: "exec", confine: true },
          loopPolicy: runtimeLoopPolicy(loadEnv({})),
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

  it.each(["guardSettings", "operatorAuthoritySeed"] as const)(
    "rejects forged host-only %s in the guest envelope",
    async (field) => {
      const root = await mkdtemp(join(tmpdir(), "clarvis-guest-auto-"));
      directories.push(root);
      const workspaceRoot = join(root, "workspace");
      await mkdir(workspaceRoot);
      const bridge: GuestExecutionBridge = {
        async model() {
          throw new Error("invalid envelope must fail before a model call");
        },
        async capability() {},
        async event() {},
        async checkpoint() {},
      };
      const hostOnly =
        field === "guardSettings"
          ? { guardSettings: { guard: { type: "shell", mode: "auto" } } }
          : {
              operatorAuthoritySeed: {
                binding: {
                  owner_key_name: "owner",
                  session_id: "session",
                  controller_epoch: "epoch",
                },
                evidence: [],
              },
            };
      await expect(
        createGuestLoopExecutor({ workspaceRoot, scratchRoot: join(root, "scratch") }).execute(
          "exec_guest_auto",
          {
            owner: "owner",
            modelLeaseId: "lease",
            toolPolicy: { enabled: true, maxGrant: "exec", confine: true },
            loopPolicy: runtimeLoopPolicy(loadEnv({})),
            ...hostOnly,
            rawBody: {
              execution_id: "exec_guest_auto",
              messages: [{ role: "user", content: "inspect this workspace" }],
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
              providers: [
                {
                  name: "anthropic",
                  kind: "openai-compatible",
                  base_url: "http://runtime-model-broker.invalid",
                },
              ],
              budget: { on_exceed: "stop", total_token_limit: 1000 },
            },
          },
          bridge,
          new AbortController().signal,
        ),
      ).rejects.toThrow("guest run envelope is invalid");
    },
  );
});
