import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "@clarvis/capability";
import { localHostPaths } from "@clarvis/paths";
import { createConnectionManager, defaultMCPClientFactory } from "@clarvis/mcp-client";
import { createMemoryTraceStore } from "@clarvis/trace/testing";
import { MockLLM } from "@clarvis/loop/testing";
import type {
  HostedRunAttachment,
  HostingService,
  KernelTransport,
  RunEvent,
  RunResult,
  StartHostedTurnParams,
} from "@clarvis/protocol";
import { createInProcessKernel } from "../../src/kernel.ts";
import { createMemoryConfigStore } from "../../src/config.ts";
import { createHostedRegistry } from "../../src/hosting/registry.ts";
import { openHostedProjection } from "../../src/hosting/projection.ts";
import { createManagedRun, type ManagedRunContext } from "../../src/runs/managed-run.ts";
import { createKernelServer } from "../../src/transport/server.ts";
import { connectKernelClient } from "../../src/transport/client.ts";
import { createLoopbackTransport } from "../../src/transport/loopback.ts";
import { connectLocalKernelTransport, listenLocalKernel } from "../../src/transport/local.ts";
import { decodeHostedFrame } from "../../src/transport/hosting-codec.ts";
import { kernelError } from "../../src/core/errors.ts";
import { kernelIdentity } from "../helpers/kernel-identity.ts";
import { N } from "../../src/transport/wire.ts";
import { wireRecord } from "../../src/transport/hosting-codec.ts";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map(async (close) => close()),
  );
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
});

const input = (id = "run-1", session = "session-1"): StartHostedTurnParams => ({
  session_id: session,
  session_revision: 0,
  kind: "conversation",
  user_preview: "Hosted prompt",
  params: { execution_id: id, messages: [{ role: "user", content: "Hosted prompt" }] },
});
const delta = (text: string): RunEvent => ({
  type: "text_delta",
  at: 1,
  agent: "lead",
  iteration: 1,
  channel: "text",
  text,
  reset: false,
});
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error("hosted transport condition timed out");
    await Bun.sleep(1);
  }
}

async function fixture(kind: "loopback" | "local") {
  const root = await mkdtemp(join(tmpdir(), "clarvis-hosted-rpc-"));
  const paths = localHostPaths({
    globalDir: join(root, "global"),
    workspaceRoot: root,
    owner: "owner",
    operatorId: "operator",
  });
  const contexts = new Map<string, ManagedRunContext>();
  const endings = new Map<string, PromiseWithResolvers<RunResult>>();
  const reconciled: string[] = [];
  let starts = 0;
  const kernel = createInProcessKernel({
    workspaceRoot: root,
    globalConfigDir: join(root, "global"),
    ...kernelIdentity(root),
    deps: {
      env: loadEnv({ CLARVIS_LOG_LEVEL: "silent", CLARVIS_AGENT_TOOLS_ENABLED: "0" }),
      workspaceRoot: root,
      llm: new MockLLM({ script: [] }),
      traceStore: createMemoryTraceStore(),
      connections: createConnectionManager({
        workspace: root,
        factory: defaultMCPClientFactory,
        connectTimeoutMs: 1000,
        callTimeoutMs: 1000,
      }),
    },
    configStore: createMemoryConfigStore({
      settings: {
        global: {
          providers: [{ name: "anthropic", kind: "anthropic" }],
          default_model: "anthropic/x",
        },
      },
    }),
  });
  const registry = createHostedRegistry({
    workspaceId: kernel.workspace.id,
    hostGeneration: "generation",
    owner: "owner",
    async prepare(value, authority) {
      authority.signal.throwIfAborted();
      return {
        title: value.user_preview,
        config: { agent: "solo" },
        detachable: true,
        async commitIntent() {},
        async start() {
          starts++;
          return createManagedRun({
            executionId: value.params.execution_id,
            execute(context) {
              const end = Promise.withResolvers<RunResult>();
              contexts.set(context.executionId, context);
              endings.set(context.executionId, end);
              context.signal.addEventListener(
                "abort",
                () => end.resolve({ execution_id: context.executionId, status: "cancelled" }),
                { once: true },
              );
              return end.promise;
            },
          });
        },
        async reconcile(result) {
          reconciled.push(result.execution_id);
        },
      };
    },
    projection: (executionId) =>
      openHostedProjection(paths.projectionFile("generation", executionId), {
        execution_id: executionId,
        host_generation: "generation",
      }),
    async removeProjection(executionId) {
      await rm(paths.projectionFile("generation", executionId));
    },
    async commit() {},
    retireConfigurationSession() {},
  });
  const closures: Promise<void>[] = [];
  const server = createKernelServer(kernel, {
    resolveConnection(params) {
      if (params.auth !== "operator-token" && params.auth !== "observer-token")
        throw kernelError("unauthorized", "invalid local credential");
      const peer = registry.connect(params.auth === "operator-token" ? "operator" : "observer");
      return {
        project: kernel.project,
        workspace: kernel.workspace,
        principal: { id: params.auth === "operator-token" ? "operator" : "observer" },
        services: {
          ...kernel.operatorServices,
          ...kernel.defaultOwnerServices,
          hosting: peer.service,
        },
        capabilities: { ...kernel.capabilities, hosting: { host_generation: "generation" } },
        close() {
          closures.push(peer.close());
        },
      };
    },
    authorize: ({ principal, metadata }) =>
      principal?.id === "operator" || (principal?.id === "observer" && metadata.access === "read"),
  });
  const listener = kind === "local" ? await listenLocalKernel(server, paths.endpoint) : undefined;
  const transports: KernelTransport[] = [];
  const transport = async () => {
    const value =
      kind === "local"
        ? await connectLocalKernelTransport(paths.endpoint)
        : createLoopbackTransport(server);
    transports.push(value);
    return value;
  };
  cleanup.push(async () => {
    await Promise.all(transports.map((value) => value.close()));
    await Promise.all(closures);
    await listener?.close();
    await registry.close();
    await kernel.close();
    if (paths.endpointDirectory !== undefined)
      await rm(paths.endpointDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  return {
    registry,
    contexts,
    reconciled,
    transport,
    connect: async (role = "operator") =>
      connectKernelClient(await transport(), { auth: `${role}-token` }),
    starts: () => starts,
    finish(id = "run-1") {
      endings
        .get(id)!
        .resolve({ execution_id: id, status: "completed", result: "Finished while detached" });
    },
    async detach(service: HostingService, id = "run-1") {
      const run = (await service.list()).find((value) => value.execution_id === id)!;
      return service.detach({
        execution_id: id,
        host_generation: run.host_generation,
        revision: run.revision,
        control_epoch: run.control_epoch,
        operation_id: `detach-${id}`,
      });
    },
  };
}

async function readSnapshot(
  service: HostingService,
  attachment: HostedRunAttachment,
): Promise<string> {
  const buffers: Buffer[] = [];
  let offset: number | undefined = 0;
  while (offset !== undefined) {
    const page = await service.readSnapshot(attachment.snapshot.snapshot_id, offset);
    buffers.push(Buffer.from(page.data_base64, "base64"));
    offset = page.next_offset;
  }
  const bytes = Buffer.concat(buffers);
  expect(bytes.byteLength).toBe(attachment.snapshot.bytes);
  let sequence = 0;
  const texts: string[] = [];
  for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) {
    const frame = decodeHostedFrame(JSON.parse(line));
    expect(frame).not.toBeNull();
    expect(frame!.first_sequence).toBe(sequence + 1);
    sequence = frame!.last_sequence;
    if (frame!.event.type === "text_delta") texts.push(frame!.event.text);
  }
  expect(sequence).toBe(attachment.snapshot.cursor.sequence);
  await service.releaseSnapshot(attachment.snapshot.snapshot_id);
  return texts.join("");
}

describe("hosted runs on the existing kernel RPC", () => {
  test("buffers sequenced tail events that arrive before the attachment reply", async () => {
    const f = await fixture("local");
    const first = await f.connect();
    await first.hosting!.start(input());
    await f.detach(first.hosting!);
    await first.close();
    const underlying = await f.transport();
    let delivered = false;
    const transport: KernelTransport = {
      ...underlying,
      onNotification(method, handler) {
        return underlying.onNotification(method, (note) => {
          handler(note);
          if (method === N.hostedObservation && wireRecord(note) && note.kind === "event")
            delivered = true;
        });
      },
      async request(method, params, options) {
        const result = await underlying.request(method, params, options);
        if (method === "hosting.attach") {
          f.contexts.get("run-1")!.emit(delta("Arrived before the reply"));
          await until(() => delivered);
        }
        return result as never;
      },
    };
    const second = await connectKernelClient(transport, { auth: "operator-token" });
    const attached = await second.hosting!.attach({
      execution_id: "run-1",
      host_generation: "generation",
      control: "acquire",
    });
    expect(attached.snapshot.cursor.sequence).toBe(0);
    const tail = Array.fromAsync(attached.handle.events);
    f.finish();
    expect(await tail).toEqual([
      { first_sequence: 1, last_sequence: 1, event: delta("Arrived before the reply") },
    ]);
    expect((await attached.handle.done).status).toBe("completed");
    await attached.handle.closed;
  });

  test("a malformed tail closes only the observing connection and permits a fresh snapshot", async () => {
    const f = await fixture("local");
    const first = await f.connect();
    await first.hosting!.start(input());
    await f.detach(first.hosting!);
    await first.close();
    const underlying = await f.transport();
    const transport: KernelTransport = {
      ...underlying,
      onNotification(method, handler) {
        return underlying.onNotification(method, (note) => {
          if (
            method === N.hostedObservation &&
            wireRecord(note) &&
            note.kind === "event" &&
            wireRecord(note.frame)
          )
            handler({ ...note, frame: { ...note.frame, first_sequence: 2, last_sequence: 2 } });
          else handler(note);
        });
      },
    };
    const second = await connectKernelClient(transport, { auth: "operator-token" });
    const attached = await second.hosting!.attach({
      execution_id: "run-1",
      host_generation: "generation",
      control: "acquire",
    });
    const outcome = attached.handle.done.then(
      () => "result",
      () => "unavailable",
    );
    f.contexts.get("run-1")!.emit(delta("Preserved on the host"));
    expect(await outcome).toBe("unavailable");
    await attached.handle.closed;
    await until(() => f.registry.stats().connections === 0);
    expect(f.contexts.get("run-1")!.signal.aborted).toBe(false);
    const third = await f.connect();
    const restored = await third.hosting!.attach({
      execution_id: "run-1",
      host_generation: "generation",
      control: "acquire",
    });
    expect(await readSnapshot(third.hosting!, restored)).toBe("Preserved on the host");
    expect(f.starts()).toBe(1);
    f.finish();
  });

  for (const kind of ["loopback", "local"] as const)
    test(`${kind}: reconnects the same execution and retrieves work completed without a client`, async () => {
      const f = await fixture(kind);
      const first = await f.connect();
      const started = await first.hosting!.start(input());
      const firstOutcome = started.handle.done.then(
        () => "result",
        () => "unavailable",
      );
      f.contexts.get("run-1")!.emit(delta("Antes. "));
      const receipt = await f.detach(first.hosting!);
      expect(receipt.run.disconnect_policy).toBe("continue");
      await first.close();
      expect(await firstOutcome).toBe("unavailable");
      await until(() => f.registry.stats().connections === 0);
      expect(f.contexts.get("run-1")!.signal.aborted).toBe(false);
      f.contexts.get("run-1")!.emit(delta("Depois de fechar a TUI: ação concluída 🦉."));
      f.finish();
      await until(() => f.reconciled.length === 1 && !f.registry.occupied("session-1"));
      const second = await f.connect();
      expect((await second.hosting!.receipt(receipt.operation_id))!.run.outcome!.status).toBe(
        "completed",
      );
      const attached = await second.hosting!.attach({
        execution_id: "run-1",
        host_generation: "generation",
        control: "acquire",
      });
      expect(attached.handle.execution_id).toBe(started.handle.execution_id);
      expect(await readSnapshot(second.hosting!, attached)).toBe(
        "Antes. Depois de fechar a TUI: ação concluída 🦉.",
      );
      expect(await Array.fromAsync(attached.handle.events)).toEqual([]);
      expect((await attached.handle.done).status).toBe("completed");
      await attached.handle.closed;
      await second.hosting!.acknowledge("run-1");
      await second.hosting!.releaseObservation(attached.observation_id);
      expect(await second.hosting!.list()).toEqual([]);
      expect(f.starts()).toBe(1);
    });

  test("an expired detached elicitation is removed from attached observers and stale controls are refused", async () => {
    const f = await fixture("local");
    const first = await f.connect();
    await first.hosting!.start(input());
    await f.detach(first.hosting!);
    await first.close();
    const abort = new AbortController();
    const answer = f.contexts.get("run-1")!.elicit(
      {
        message: "Approve this operation?",
        requestedSchema: { type: "object", properties: {}, required: [] },
      },
      { signal: abort.signal },
    );
    const second = await f.connect();
    const attached = await second.hosting!.attach({
      execution_id: "run-1",
      host_generation: "generation",
      control: "acquire",
    });
    expect(attached.pending_elicitations).toHaveLength(1);
    const id = attached.pending_elicitations[0]!.id;
    const settlements: string[] = [];
    attached.handle.onElicitSettled!((value) => settlements.push(value));
    const observer = await f.connect("observer");
    await expect(
      observer.hosting!.attach({
        execution_id: "run-1",
        host_generation: "generation",
        control: "takeover",
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const readOnly = await observer.hosting!.attach({
      execution_id: "run-1",
      host_generation: "generation",
      control: "observe",
    });
    await expect(readOnly.handle.cancel()).rejects.toMatchObject({ code: "unauthorized" });
    abort.abort();
    expect(await answer).toEqual({ action: "cancel" });
    await until(() => settlements.includes(id));
    const late: string[] = [];
    attached.handle.onElicit((question) => late.push(question.id));
    expect(late).toEqual([]);
    await expect(attached.handle.respond({ id, action: "accept" })).rejects.toMatchObject({
      code: "not_found",
    });
    const third = await f.connect();
    await third.hosting!.attach({
      execution_id: "run-1",
      host_generation: "generation",
      control: "takeover",
    });
    await expect(attached.handle.cancel()).rejects.toMatchObject({ code: "conflict" });
    f.finish();
  });

  test("a lost detach response is reconciled by receipt without another start or mutation replay", async () => {
    const f = await fixture("loopback");
    const underlying = await f.transport();
    const transport: KernelTransport = {
      ...underlying,
      async request(method, params, options) {
        const result = await underlying.request(method, params, options);
        if (method === "hosting.detach") {
          await underlying.close();
          throw kernelError("unavailable", "response lost");
        }
        return result as never;
      },
    };
    const first = await connectKernelClient(transport, { auth: "operator-token" });
    await first.hosting!.start(input());
    await expect(f.detach(first.hosting!)).rejects.toMatchObject({ code: "unavailable" });
    await until(() => f.registry.stats().connections === 0);
    const second = await f.connect();
    expect((await second.hosting!.receipt("detach-run-1"))!.run.disconnect_policy).toBe("continue");
    expect(f.starts()).toBe(1);
    expect(f.contexts.get("run-1")!.signal.aborted).toBe(false);
    f.finish();
  });

  test("closing an unpromoted run cancels it while an independent promoted conversation continues", async () => {
    const f = await fixture("local");
    const first = await f.connect();
    await first.hosting!.start(input());
    await f.detach(first.hosting!);
    await first.hosting!.start(input("run-2", "session-2"));
    await first.close();
    await until(() => f.contexts.get("run-2")!.signal.aborted);
    expect(f.contexts.get("run-1")!.signal.aborted).toBe(false);
    const second = await f.connect();
    await expect(
      second.hosting!.attach({
        execution_id: "run-1",
        host_generation: "retired-generation",
        control: "observe",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    f.finish();
  });
});
