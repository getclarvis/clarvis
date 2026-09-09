import { describe, expect, it } from "bun:test";
import type { KernelRequestOptions, KernelTransport, RunEvent } from "@clarvis/protocol";
import { connectKernelClient } from "../../src/transport/client.ts";
import { decodeRunEvent } from "../../src/transport/run-event-codec.ts";
import {
  KNOWN_METHODS,
  OPERATIONS,
  ORDINARY_OPERATIONS,
  SPECIAL_OPERATIONS,
} from "../../src/transport/operations.ts";
import type { HelloResult } from "../../src/transport/wire.ts";
import {
  createRecordingKernelServices,
  RECORDED_OPERATION,
} from "../helpers/recording-kernel-services.ts";

const HELLO = {
  wire_version: 4,
  capabilities: {
    memory: false,
    skills: false,
    agent_tools: true,
    tasks: false,
  },
  project: { id: "prj_test", label: "Test project" },
  workspace: {
    id: "ws_test",
    projectId: "prj_test",
    label: "Primary",
    kind: "primary",
    path: "/ws",
  },
} satisfies HelloResult;

interface RequestRecord {
  method: string;
  params: unknown;
  options?: KernelRequestOptions;
}

class FakeTransport implements KernelTransport {
  readonly requests: RequestRecord[] = [];
  readonly notifications = new Map<string, ((params: unknown) => void)[]>();
  readonly closeHandlers = new Set<(reason?: unknown) => void>();
  helloResult: unknown = HELLO;
  helloError: unknown;
  closeCount = 0;
  onRequest?: (method: string, params: unknown) => unknown | Promise<unknown>;

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: KernelRequestOptions,
  ): Promise<T> {
    this.requests.push({ method, params, ...(options === undefined ? {} : { options }) });
    if (method === SPECIAL_OPERATIONS.hello.method) {
      if (this.helloError !== undefined) throw this.helloError;
      return this.helloResult as T;
    }
    return (await this.onRequest?.(method, params)) as T;
  }

  notify(): void {}

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const handlers = this.notifications.get(method) ?? [];
    handlers.push(handler);
    this.notifications.set(method, handlers);
    return () => {
      this.notifications.set(
        method,
        (this.notifications.get(method) ?? []).filter((candidate) => candidate !== handler),
      );
    };
  }

  onClose(handler: (reason?: unknown) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  emit(method: string, params: unknown): void {
    for (const handler of this.notifications.get(method) ?? []) handler(params);
  }

  disconnect(reason?: unknown): void {
    for (const handler of this.closeHandlers) handler(reason);
    this.closeHandlers.clear();
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.disconnect();
  }
}

describe("wire handshake", () => {
  it("rejects mismatched or structurally invalid hello responses and closes the transport", async () => {
    for (const helloResult of [
      null,
      { ...HELLO, wire_version: 1 },
      { ...HELLO, unexpected: true },
      { ...HELLO, workspace: { ...HELLO.workspace, kind: "unknown" } },
      {
        ...HELLO,
        capabilities: {
          ...HELLO.capabilities,
          runtime: { kind: "container", engine: "podman", generation: "forged" },
        },
      },
    ]) {
      const transport = new FakeTransport();
      transport.helloResult = helloResult;
      await expect(connectKernelClient(transport)).rejects.toThrow(
        "invalid or unsupported Clarvis wire contract",
      );
      expect(transport.closeCount).toBe(1);
    }
  });

  it("preserves a complete effective runtime status", async () => {
    for (const engine of ["podman", "docker"] as const) {
      const transport = new FakeTransport();
      transport.helloResult = {
        ...HELLO,
        capabilities: {
          ...HELLO.capabilities,
          runtime: {
            kind: "container",
            generation: "generation-1",
            engine,
            engine_version: "5.4.0",
            host_platform: "linux",
            guest_platform: "linux",
            image_digest: `sha256:${"a".repeat(64)}`,
            runtime_protocol_revision: "1",
            network: "none",
            lifecycle: "ready",
          },
        },
      };
      const client = await connectKernelClient(transport);
      expect(client.capabilities.runtime).toMatchObject({
        kind: "container",
        engine,
        guest_platform: "linux",
      });
      await client.close();
    }
  });

  it("closes and detaches every observer when hello rejects", async () => {
    const transport = new FakeTransport();
    transport.helloError = new Error("handshake unavailable");

    await expect(connectKernelClient(transport)).rejects.toThrow("handshake unavailable");

    expect(transport.closeCount).toBe(1);
    expect(transport.closeHandlers.size).toBe(0);
    expect(
      [...transport.notifications.values()].every((handlers) => handlers.length === 0),
    ).toBeTrue();
  });
});

describe("transport operation descriptors", () => {
  it("owns one unique method name and invokes every ordinary service method through its codec", async () => {
    expect(new Set(KNOWN_METHODS).size).toBe(KNOWN_METHODS.length);
    const invoked: string[] = [];
    const services = createRecordingKernelServices(invoked);

    for (const operation of ORDINARY_OPERATIONS) {
      const params = operation.encode() as Record<string, unknown>;
      try {
        await operation.invoke(services, params);
        throw new Error(`operation '${operation.method}' did not reach its service fake`);
      } catch (error) {
        expect(error).toBe(RECORDED_OPERATION);
      }
    }

    expect(invoked).toEqual(ORDINARY_OPERATIONS.map((operation) => operation.method));
  });

  it("classifies every Extension Profile operation as plugin-sensitive with exact read/write access", () => {
    const expected = {
      list: "read",
      current: "read",
      get: "read",
      inventory: "read",
      preview: "read",
      previewClear: "read",
      previewComposition: "read",
      select: "write",
      clearSelection: "write",
      applyComposition: "write",
      create: "write",
      update: "write",
      delete: "write",
      clone: "write",
    } as const;

    for (const [name, access] of Object.entries(expected)) {
      expect(OPERATIONS.extensionProfiles[name as keyof typeof expected].metadata).toEqual({
        access,
        sensitivity: "plugins",
      });
    }
  });

  it("binds an Extension Profile preview request to its persisted selection scope", () => {
    expect(
      OPERATIONS.extensionProfiles.preview.encode(
        { scope: "global", name: "research" },
        { selection_scope: "workspace" },
      ),
    ).toEqual({
      ref: { scope: "global", name: "research" },
      options: { selection_scope: "workspace" },
    });
  });

  it("keeps every optional transport request projection inert without a signal", () => {
    const projections = ORDINARY_OPERATIONS.filter(
      (operation) => operation.requestOptions !== undefined,
    );

    for (const operation of projections) {
      const requestOptions = operation.requestOptions!.bind(undefined) as (
        ...args: unknown[]
      ) => unknown;
      expect(requestOptions(undefined, undefined)).toBeUndefined();
    }
  });

  it("passes transport cancellation to a signal-aware session catalog scan", async () => {
    const services = createRecordingKernelServices([]);
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    services.sessions.listPage = async (_page, options?: { signal?: AbortSignal }) => {
      received = options?.signal;
      return { items: [] };
    };

    await OPERATIONS.sessions.listPage.invoke(services, { page: { limit: 1 } }, controller.signal);

    expect(received).toBe(controller.signal);
  });

  it("passes transport cancellation to a signal-aware workflow catalog scan", async () => {
    const services = createRecordingKernelServices([]);
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    services.workflows.list = async (_page, options?: { signal?: AbortSignal }) => {
      received = options?.signal;
      return { items: [], total: 0, limit: 20, offset: 0 };
    };

    await OPERATIONS.workflows.list.invoke(services, { page: { limit: 1 } }, controller.signal);

    expect(received).toBe(controller.signal);
  });
});

describe("remote run codec", () => {
  it("preserves the terminal shell auto-guard verdict", () => {
    const event = {
      type: "tool_call",
      at: 12,
      agent: "lead",
      call_id: "c1",
      tool: "shell",
      server: "",
      ok: true,
      guard: { mode: "auto", outcome: "allowed", answerer: "judge" },
    } as const;
    expect(decodeRunEvent(event)).toEqual(event);
  });

  it("preserves an iteration's declared assistant response phase", () => {
    const event = {
      type: "iteration_completed",
      at: 13,
      agent: "lead",
      iteration: 2,
      model: "gpt-5.6",
      response: "Checking now.",
      response_phase: "commentary",
      input_tokens: 10,
      output_tokens: 3,
    } as const;
    expect(decodeRunEvent(event)).toEqual(event);
  });

  it("preserves explicit tool-input completion and rejects wider lifecycle shapes", () => {
    const event = {
      type: "tool_input_delta",
      at: 14,
      agent: "lead",
      call_id: "call-write",
      tool: "write_file",
      chars: 48_147,
      stream_chars: 49_000,
      complete: true,
    } as const;

    expect(decodeRunEvent(event)).toEqual(event);
    expect(decodeRunEvent({ ...event, complete: false })).toBeNull();
    expect(decodeRunEvent({ ...event, done: true })).toBeNull();
  });

  it("preserves compaction lifecycle and fallback attribution", () => {
    const started = {
      type: "compaction_started",
      at: 14,
      agent: "lead",
      mode: "scheduled",
    } as const;
    const fallback = {
      type: "compaction",
      at: 15,
      agent: "lead",
      operation: "eviction",
      fallback_reason: "summarization_failed",
    } as const;
    expect(decodeRunEvent(started)).toEqual(started);
    expect(decodeRunEvent(fallback)).toEqual(fallback);
  });

  it("preserves the workflow round checkpoint contract", () => {
    const event = {
      type: "workflow_sequence_state",
      at: 16,
      run_id: "manager",
      session_id: "wfseq-1",
      status: "awaiting_manager",
      revision: 2,
      round_id: "review",
      pass: 0,
      next_round_id: "verify",
      next_pass: 0,
      leaders_started: 7,
      max_total_leaders: 32,
    } as const;
    expect(decodeRunEvent(event)).toEqual(event);
    expect(decodeRunEvent({ ...event, revision: -1 })).toBeNull();
    expect(decodeRunEvent({ ...event, next_pass: 0.5 })).toBeNull();
    expect(decodeRunEvent({ ...event, leaders_started: 33 })).toBeNull();
  });

  it("settles the result independently and keeps accepting events until stream_end", async () => {
    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-note", messages: [] });
    const event: RunEvent = { type: "run_started", at: 10 };

    transport.emit("run.event", { execution_id: handle.execution_id, event });
    transport.emit("run.result", {
      execution_id: handle.execution_id,
      result: { execution_id: handle.execution_id, status: "completed" },
    });
    expect(await handle.done).toEqual({ execution_id: "exec-note", status: "completed" });
    let closed = false;
    void handle.closed.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    const lateEvent: RunEvent = { type: "run_ended", at: 11, status: "completed" };
    transport.emit("run.event", { execution_id: handle.execution_id, event: lateEvent });
    transport.emit("run.stream_end", { execution_id: handle.execution_id });
    await handle.closed;
    expect(closed).toBe(true);

    const events: RunEvent[] = [];
    for await (const value of handle.events) events.push(value);
    expect(events).toEqual([event, lateEvent]);
    await client.close();
  });

  it("settles a start rejection as a failed result with the transport error code", async () => {
    const transport = new FakeTransport();
    transport.onRequest = (method) => {
      if (method !== SPECIAL_OPERATIONS.runsStart.method) return {};
      const error = new Error("boom") as Error & { code: "invalid_request" };
      error.code = "invalid_request";
      throw error;
    };
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-boom", messages: [] });

    expect(await handle.done).toMatchObject({
      execution_id: "exec-boom",
      status: "failed",
      error: { code: "invalid_request", message: "boom" },
    });
    await expect(handle.closed).resolves.toBeUndefined();
    expect(
      await (async () => {
        const events: RunEvent[] = [];
        for await (const event of handle.events) events.push(event);
        return events;
      })(),
    ).toEqual([]);
    await client.close();
  });

  it("rejects a duplicate live execution id without replacing the first handle", async () => {
    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const first = await client.runs.start({ execution_id: "exec-duplicate", messages: [] });

    await expect(
      client.runs.start({ execution_id: "exec-duplicate", messages: [] }),
    ).rejects.toMatchObject({ code: "conflict" });

    transport.emit("run.result", {
      execution_id: first.execution_id,
      result: { execution_id: first.execution_id, status: "completed" },
    });
    transport.emit("run.stream_end", { execution_id: first.execution_id });
    expect((await first.done).status).toBe("completed");
    await client.close();
  });

  it("forwards steer, compact, cancel, and respond with the handle's execution id", async () => {
    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-control", messages: [] });

    await handle.steer("hi");
    await handle.compact("keep auth context");
    await handle.cancel();
    await handle.respond({
      id: "exec-control:elicit:0",
      action: "accept",
      content: { response: "ok" },
    });

    expect(transport.requests.slice(1).map(({ method, params }) => ({ method, params }))).toEqual([
      {
        method: "runs.start",
        params: { params: { execution_id: "exec-control", messages: [] } },
      },
      {
        method: "runs.steer",
        params: { execution_id: "exec-control", message: "hi" },
      },
      {
        method: "runs.compact",
        params: { execution_id: "exec-control", request: "keep auth context" },
      },
      { method: "runs.cancel", params: { execution_id: "exec-control" } },
      {
        method: "runs.respond",
        params: {
          execution_id: "exec-control",
          response: {
            id: "exec-control:elicit:0",
            action: "accept",
            content: { response: "ok" },
          },
        },
      },
    ]);
    await client.close();
  });

  it("buffers an elicitation emitted before runs.start returns", async () => {
    const transport = new FakeTransport();
    transport.onRequest = (method) => {
      if (method === SPECIAL_OPERATIONS.runsStart.method) {
        transport.emit("run.elicitation", {
          request: {
            id: "exec-early:elicit:0",
            execution_id: "exec-early",
            kind: "ask_user",
            prompt: "Approve?",
          },
        });
      }
      return {};
    };
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-early", messages: [] });
    let prompt = "";

    handle.onElicit((request) => {
      prompt = request.prompt;
    });

    expect(prompt).toBe("Approve?");
    await client.close();
    expect((await handle.done).error?.code).toBe("unavailable");
  });

  it("settles every live handle as unavailable when the transport disconnects", async () => {
    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-disconnect", messages: [] });

    transport.disconnect(new Error("pipe vanished"));

    expect(await handle.done).toMatchObject({
      status: "failed",
      error: { code: "unavailable", message: "pipe vanished" },
    });
    await client.close();
  });

  it("carries a failed run's error code instead of killing the connection", async () => {
    expect(
      decodeRunEvent({
        type: "run_ended",
        at: 11,
        status: "failed",
        reason: "error",
        code: "provider_error",
      }),
    ).toEqual({
      type: "run_ended",
      at: 11,
      status: "failed",
      reason: "error",
      code: "provider_error",
    });

    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-ended-code", messages: [] });
    const ended: RunEvent = {
      type: "run_ended",
      at: 11,
      status: "failed",
      reason: "error",
      code: "provider_error",
    };

    transport.emit("run.event", { execution_id: handle.execution_id, event: ended });
    transport.emit("run.stream_end", { execution_id: handle.execution_id });
    transport.emit("run.result", {
      execution_id: handle.execution_id,
      result: { execution_id: handle.execution_id, status: "failed" },
    });

    const events: RunEvent[] = [];
    for await (const value of handle.events) events.push(value);
    expect(events).toEqual([ended]);
    expect(transport.closeCount).toBe(0);
    await client.close();
  });

  it("delivers a well-formed guard_confirm detail", async () => {
    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-detail-ok", messages: [] });
    let seen: unknown;
    handle.onElicit((request) => {
      seen = request.detail;
    });

    transport.emit("run.elicitation", {
      request: {
        id: "exec-detail-ok:elicit:0",
        execution_id: "exec-detail-ok",
        kind: "guard_confirm",
        prompt: "Approve?",
        schema: { type: "object", properties: {} },
        detail: { command: "rm -rf /", cwd: "/ws", reason: "destructive", warning: "undecidable" },
      },
    });

    expect(seen).toEqual({
      command: "rm -rf /",
      cwd: "/ws",
      reason: "destructive",
      warning: "undecidable",
    });
    expect(transport.closeCount).toBe(0);
    await client.close();
  });

  it.each([
    ["not a record", "rm -rf /"],
    ["a missing command", { cwd: "/ws", reason: "destructive" }],
    ["a non-string command", { command: 12, cwd: "/ws", reason: "destructive" }],
    ["a non-string warning", { command: "ls", cwd: "/ws", reason: "x", warning: 7 }],
    ["an unknown key", { command: "ls", cwd: "/ws", reason: "x", extra: true }],
  ])("closes fail-closed on a guard_confirm detail with %s", async (_label, detail) => {
    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-detail-bad", messages: [] });

    transport.emit("run.elicitation", {
      request: {
        id: "exec-detail-bad:elicit:0",
        execution_id: "exec-detail-bad",
        kind: "guard_confirm",
        prompt: "Approve?",
        detail,
      },
    });

    expect(await handle.done).toMatchObject({
      status: "failed",
      error: { code: "unavailable", message: expect.stringContaining("protocol violation") },
    });
    expect(transport.closeCount).toBe(1);
    await client.close();
  });

  it("leaves an unknown elicitation kind and an opaque schema alone", async () => {
    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-open-kind", messages: [] });
    let seen: unknown;
    handle.onElicit((request) => {
      seen = request.kind;
    });

    transport.emit("run.elicitation", {
      request: {
        id: "exec-open-kind:elicit:0",
        execution_id: "exec-open-kind",
        kind: "a_kind_this_client_predates",
        prompt: "Answer?",
        schema: { anything: ["at", "all"] },
      },
    });

    expect(seen).toBe("a_kind_this_client_predates");
    expect(transport.closeCount).toBe(0);
    await client.close();
  });

  it("closes fail-closed on a malformed run notification", async () => {
    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-invalid-note", messages: [] });

    transport.emit("run.event", {
      execution_id: handle.execution_id,
      event: { type: "run_started", at: "not-a-number" },
    });

    expect(await handle.done).toMatchObject({
      status: "failed",
      error: {
        code: "unavailable",
        message: expect.stringContaining("protocol violation"),
      },
    });
    expect(transport.closeCount).toBe(1);
    await client.close();
  });

  it("rejects a known run-event discriminator with an incomplete payload", async () => {
    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({ execution_id: "exec-incomplete-event", messages: [] });

    transport.emit("run.event", {
      execution_id: handle.execution_id,
      event: { type: "text_delta", at: 1 },
    });

    expect(await handle.done).toMatchObject({
      status: "failed",
      error: {
        code: "unavailable",
        message: expect.stringContaining("protocol violation"),
      },
    });
    expect(transport.closeCount).toBe(1);
    await client.close();
  });

  it("rejects inherited object keys as unknown run-event discriminators", async () => {
    for (const type of ["toString", "constructor", "__proto__"]) {
      const transport = new FakeTransport();
      const client = await connectKernelClient(transport);
      const handle = await client.runs.start({
        execution_id: `exec-inherited-${type}`,
        messages: [],
      });

      transport.emit("run.event", {
        execution_id: handle.execution_id,
        event: { type, at: 1 },
      });

      expect(await handle.done).toMatchObject({
        status: "failed",
        error: {
          code: "unavailable",
          message: expect.stringContaining("protocol violation"),
        },
      });
      expect(transport.closeCount).toBe(1);
      await client.close();
    }
  });

  it.each([
    ["run.result", { execution_id: "exec-invalid-envelope", result: { status: "bogus" } }],
    ["run.stream_end", { execution_id: 7 }],
    ["config.change", { subscription_id: "config-invalid", change: { kind: "unknown", at: 1 } }],
  ])("closes fail-closed on an invalid %s envelope", async (method, params) => {
    const transport = new FakeTransport();
    const client = await connectKernelClient(transport);
    const handle = await client.runs.start({
      execution_id: "exec-invalid-envelope",
      messages: [],
    });

    transport.emit(method, params);

    expect(await handle.done).toMatchObject({
      status: "failed",
      error: { code: "unavailable", message: expect.stringContaining("protocol violation") },
    });
    expect(transport.closeCount).toBe(1);
    await client.close();
  });

  it("cancels remote runs whose event stream is abandoned or saturated", async () => {
    const abandonedTransport = new FakeTransport();
    const abandonedClient = await connectKernelClient(abandonedTransport);
    const abandoned = await abandonedClient.runs.start({
      execution_id: "exec-abandoned",
      messages: [],
    });
    const iterator = abandoned.events[Symbol.asyncIterator]();
    await iterator.return?.();
    await Promise.resolve();
    expect(abandonedTransport.requests.some(({ method }) => method === "runs.cancel")).toBeTrue();
    await abandonedClient.close();

    const saturatedTransport = new FakeTransport();
    const saturatedClient = await connectKernelClient(saturatedTransport);
    const saturated = await saturatedClient.runs.start({
      execution_id: "exec-saturated",
      messages: [],
    });
    for (let index = 0; index < 1_100; index += 1) {
      saturatedTransport.emit("run.event", {
        execution_id: saturated.execution_id,
        event: { type: "run_started", at: index },
      });
    }
    await Promise.resolve();
    expect(saturatedTransport.requests.some(({ method }) => method === "runs.cancel")).toBeTrue();
    await saturatedClient.close();
  });
});

describe("remote Tasks codec", () => {
  it("preserves a create request id and its pinned provider selection", async () => {
    const transport = new FakeTransport();
    transport.onRequest = () => ({});
    const client = await connectKernelClient(transport);
    const input = {
      request_id: "create-stable",
      provider_key: "tasks:mcp:v2:sha256:provider-a",
      container_id: "CLAR",
      title: "Pinned create",
    };

    await client.tasks.create(input);

    expect(transport.requests.at(-1)).toEqual({
      method: "tasks.create",
      params: { input },
    });
    await client.close();
  });

  it("preserves opaque cursors and forwards cancellation as transport metadata", async () => {
    const transport = new FakeTransport();
    transport.onRequest = (method) =>
      method === OPERATIONS.tasks.search.method ? { items: [], next_cursor: "opaque==" } : {};
    const client = await connectKernelClient(transport);
    const controller = new AbortController();

    await expect(
      client.tasks.search({ cursor: "opaque==", limit: 25 }, { signal: controller.signal }),
    ).resolves.toEqual({ items: [], next_cursor: "opaque==" });
    expect(transport.requests.at(-1)).toEqual({
      method: "tasks.search",
      params: { input: { cursor: "opaque==", limit: 25 } },
      options: { signal: controller.signal },
    });
    await client.close();
  });
});
