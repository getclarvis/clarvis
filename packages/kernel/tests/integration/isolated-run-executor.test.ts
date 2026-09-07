import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_ENV } from "@clarvis/paths";
import { createSteerQueue } from "../../src/runs/steer-queue.ts";
import {
  createCapabilityBroker,
  createIsolatedRunExecutor,
  createModelBroker,
  createRuntimeAuthorityRouter,
  type RuntimeInfo,
  type RuntimeSession,
} from "../../src/index.ts";

const directories: string[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("isolated run executor", () => {
  it.each(["delivered", "refused", "settled"] as const)(
    "settles steering only on guest delivery and always revokes authority: %s",
    async (delivery) => {
      const root = await mkdtemp(join(tmpdir(), "clarvis-steer-authority-"));
      directories.push(root);
      const router = createRuntimeAuthorityRouter("generation");
      const steer = createSteerQueue();
      const received = deferred();
      const deliver = deferred();
      const finish = deferred();
      const revoked: string[] = [];
      let acknowledged: boolean | undefined;
      const acknowledgement = steer.push({ content: "steer payload" }).then((value) => {
        acknowledged = value;
        return value;
      });
      const executor = createIsolatedRunExecutor({
        generation: "generation",
        workspaceRoot: join(root, "workspace"),
        roots: { env: { [HOME_ENV]: join(root, "home") } },
        router,
        pollIntervalMs: 5,
        session: {
          closed: false,
          info: {} as RuntimeInfo,
          async startRun(runId) {
            await finish.promise;
            await router.handlers["host.checkpoint"]!({
              method: "host.checkpoint",
              generation: "generation",
              runId,
              signal: new AbortController().signal,
              payload: { sequence: 1, terminal: false, state: {} },
            });
            return { executionId: runId, response: { status: "completed" } };
          },
          async steer() {
            received.resolve();
            await deliver.promise;
            if (delivery !== "delivered")
              throw Object.assign(new Error("guest finished"), { code: "not_found" });
          },
          async cancel() {},
          async stop() {},
          async exposePort() {
            throw new Error("not exercised");
          },
        },
        authority: () => ({
          model: {
            async execute() {
              return { events: [], outputBytes: 0 };
            },
            revoke() {
              revoked.push("model");
            },
          },
          capabilities: {
            async invoke() {},
            revoke() {
              revoked.push("capabilities");
            },
          },
          terminalParticipants: () =>
            (["session", "trace", "capabilities"] as const).map((name) => ({
              name,
              async commit() {},
            })),
          dispose() {
            revoked.push("snapshot");
          },
        }),
      });
      const running = executor({
        rawBody: { execution_id: "run" },
        owner: "owner",
        deps: {} as never,
        steer,
      });
      try {
        await received.promise;
        expect(acknowledged).toBeUndefined();
        if (delivery === "settled") finish.resolve();
        else {
          deliver.resolve();
          expect(await acknowledgement).toBe(delivery === "delivered");
          finish.resolve();
        }
        await expect(running).resolves.toMatchObject({ response: { status: "completed" } });
        expect(await acknowledgement).toBe(delivery === "delivered");
        expect(revoked).toEqual(["model", "capabilities", "snapshot"]);
        await expect(
          router.handlers["host.event"]!({
            method: "host.event",
            generation: "generation",
            runId: "run",
            signal: new AbortController().signal,
            payload: { channel: "trace", event: {} },
          }),
        ).rejects.toMatchObject({ code: "unauthorized" });
      } finally {
        deliver.resolve();
        finish.resolve();
        steer.close();
        await running.catch(() => undefined);
      }
    },
  );

  it("keeps the authority router generation- and run-bound", async () => {
    const router = createRuntimeAuthorityRouter("generation-1");
    const signal = new AbortController().signal;
    await expect(
      router.handlers["host.event"]!({
        method: "host.event",
        generation: "forged",
        runId: "run-1",
        payload: {},
        signal,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      router.handlers["host.event"]!({
        method: "host.event",
        generation: "generation-1",
        runId: "missing",
        payload: {},
        signal,
      }),
    ).rejects.toMatchObject({ code: "unauthorized" });
    const handlers = { "host.event": async () => ({ ok: true }) };
    const release = router.bind("run-1", handlers);
    expect(() => router.bind("run-1", handlers)).toThrow("already bound");
    await expect(
      router.handlers["host.event"]!({
        method: "host.event",
        generation: "generation-1",
        runId: "run-1",
        payload: {},
        signal,
      }),
    ).resolves.toEqual({ ok: true });
    release();
    release();
  });

  it("routes events and refuses completion before the host terminal barrier", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-isolated-executor-"));
    directories.push(root);
    const workspaceRoot = join(root, "workspace");
    const roots = { env: { [HOME_ENV]: join(root, "home") } };
    const generation = "generation-1";
    const router = createRuntimeAuthorityRouter(generation);
    const signal = new AbortController().signal;
    const calls: string[] = [];
    const persisted: unknown[] = [];
    const info: RuntimeInfo = {
      kind: "container",
      generation,
      engine: "podman",
      engineVersion: "5",
      hostPlatform: "linux",
      guestPlatform: "linux",
      imageDigest: `sha256:${"a".repeat(64)}`,
      runtimeProtocolRevision: "2",
      network: "none",
      limits: { cpuCount: 1, memoryBytes: 1, processCount: 1, outputBytes: 1, storageBytes: 1 },
      lifecycle: "ready",
    };
    const session: RuntimeSession = {
      closed: false,
      info,
      async startRun(runId) {
        await router.handlers["host.event"]!({
          method: "host.event",
          generation,
          runId,
          payload: { channel: "trace", event: { type: "run_started" } },
          signal,
        });
        await router.handlers["host.event"]!({
          method: "host.event",
          generation,
          runId,
          payload: { channel: "capability", event: { type: "capability_event" } },
          signal,
        });
        await router.handlers["host.event"]!({
          method: "host.event",
          generation,
          runId,
          payload: {
            channel: "trace_record",
            record: { id: runId, owner_key_name: "owner" },
          },
          signal,
        });
        await router.handlers["host.checkpoint"]!({
          method: "host.checkpoint",
          generation,
          runId,
          payload: { sequence: 1, terminal: false, state: { complete: true } },
          signal,
        });
        return { executionId: runId, response: { status: "done" } };
      },
      async steer() {},
      async cancel() {},
      async exposePort() {
        throw new Error("not exercised");
      },
      async stop() {},
    };
    const executor = createIsolatedRunExecutor({
      generation,
      workspaceRoot,
      roots,
      session,
      router,
      pollIntervalMs: 5,
      authority: () => ({
        model: createModelBroker(
          {
            id: "lease",
            generation,
            runId: "run-1",
            provider: "p",
            model: "m",
            destination: new URL("https://example.test"),
            expiresAt: Date.now() + 60_000,
            maxConcurrent: 1,
            maxInputBytes: 128,
            maxOutputBytes: 128,
          },
          async function* () {},
        ),
        capabilities: createCapabilityBroker({
          generation,
          runId: "run-1",
          grants: [],
          maxArgumentsBytes: 128,
          maxResultBytes: 128,
        }),
        terminalParticipants: () =>
          (["session", "trace", "capabilities"] as const).map((name) => ({
            name,
            async commit() {
              calls.push(name);
            },
          })),
        roots,
      }),
    });
    const events: unknown[] = [];
    const capabilityEvents: unknown[] = [];
    const steers = [{ content: "message" }];
    const compactions = [{ request: "manual" }];
    await expect(
      executor({
        rawBody: { execution_id: "run-1" },
        owner: "owner",
        deps: {
          traceStore: {
            async insert(record: unknown) {
              persisted.push(record);
            },
          },
        } as never,
        onEvent: (event) => events.push(event),
        onCapabilityEvent: (event) => capabilityEvents.push(event),
        steer: { drain: () => steers.splice(0) },
        compaction: { drain: () => compactions.splice(0) },
      }),
    ).resolves.toMatchObject({ executionId: "run-1" });
    expect(events).toEqual([{ type: "run_started" }]);
    expect(persisted).toEqual([{ id: "run-1", owner_key_name: "owner" }]);
    expect(capabilityEvents).toEqual([{ type: "capability_event" }]);
    expect(calls).toEqual(["session", "trace", "capabilities"]);
  });

  it("refuses malformed results, missing checkpoints, and forged guest events", async () => {
    const root = await mkdtemp(join(tmpdir(), "clarvis-isolated-executor-refusal-"));
    directories.push(root);
    const roots = { env: { [HOME_ENV]: join(root, "home") } };
    const generation = "generation-1";
    const signal = new AbortController().signal;
    const info: RuntimeInfo = {
      kind: "container",
      generation,
      engine: "podman",
      engineVersion: "5",
      hostPlatform: "linux",
      guestPlatform: "linux",
      imageDigest: `sha256:${"a".repeat(64)}`,
      runtimeProtocolRevision: "2",
      network: "none",
      limits: { cpuCount: 1, memoryBytes: 1, processCount: 1, outputBytes: 1, storageBytes: 1 },
      lifecycle: "ready",
    };
    const authority = (runId: string) => ({
      model: createModelBroker(
        {
          id: "lease",
          generation,
          runId,
          provider: "p",
          model: "m",
          destination: new URL("https://example.test"),
          expiresAt: Date.now() + 60_000,
          maxConcurrent: 1,
          maxInputBytes: 128,
          maxOutputBytes: 128,
        },
        async function* () {},
      ),
      capabilities: createCapabilityBroker({
        generation,
        runId,
        grants: [],
        maxArgumentsBytes: 128,
        maxResultBytes: 128,
      }),
      terminalParticipants: () => [],
    });
    const args = {
      owner: "owner",
      deps: { traceStore: { insert: async () => undefined } } as never,
    };

    const invalidRouter = createRuntimeAuthorityRouter(generation);
    const invalid = createIsolatedRunExecutor({
      generation,
      workspaceRoot: join(root, "workspace"),
      roots,
      router: invalidRouter,
      session: {
        closed: false,
        info,
        startRun: async () => null,
        steer: async () => undefined,
        cancel: async () => undefined,
        exposePort: async () => Promise.reject(new Error("not exercised")),
        stop: async () => undefined,
      },
      authority: (_value, runId) => authority(runId),
    });
    await expect(invalid({ ...args, rawBody: {} })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      invalid({ ...args, rawBody: { execution_id: "invalid-result" } }),
    ).rejects.toMatchObject({ code: "unavailable" });

    const noCheckpointRouter = createRuntimeAuthorityRouter(generation);
    const noCheckpoint = createIsolatedRunExecutor({
      generation,
      workspaceRoot: join(root, "workspace"),
      roots,
      router: noCheckpointRouter,
      session: {
        closed: false,
        info,
        startRun: async (runId) => ({ executionId: runId, response: { status: "done" } }),
        steer: async () => undefined,
        cancel: async () => undefined,
        exposePort: async () => Promise.reject(new Error("not exercised")),
        stop: async () => undefined,
      },
      authority: (_value, runId) => authority(runId),
    });
    await expect(
      noCheckpoint({ ...args, rawBody: { execution_id: "no-checkpoint" } }),
    ).rejects.toMatchObject({ code: "unavailable" });

    const boundaryController = new AbortController();
    const boundaryOrder: string[] = [];
    const boundaryRouter = createRuntimeAuthorityRouter(generation);
    const boundary = createIsolatedRunExecutor({
      generation,
      workspaceRoot: join(root, "workspace"),
      roots,
      router: boundaryRouter,
      session: {
        closed: false,
        info,
        async startRun() {
          boundaryOrder.push("start");
          boundaryController.abort();
          return null;
        },
        steer: async () => undefined,
        cancel: async () => {
          boundaryOrder.push("cancel");
        },
        exposePort: async () => Promise.reject(new Error("not exercised")),
        stop: async () => undefined,
      },
      authority: (_value, runId) => authority(runId),
    });
    await expect(
      boundary({
        ...args,
        rawBody: { execution_id: "boundary-abort" },
        externalSignal: boundaryController.signal,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(boundaryOrder).toEqual(["start", "cancel"]);

    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => (releaseStart = resolve));
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    let cancelled = false;
    let startSignal: AbortSignal | undefined;
    const abortRouter = createRuntimeAuthorityRouter(generation);
    const aborting = createIsolatedRunExecutor({
      generation,
      workspaceRoot: join(root, "workspace"),
      roots,
      router: abortRouter,
      session: {
        closed: false,
        info,
        async startRun(_runId, _envelope, signal) {
          startSignal = signal;
          markStarted();
          await startGate;
          return null;
        },
        steer: async () => undefined,
        cancel: async () => {
          cancelled = true;
        },
        exposePort: async () => Promise.reject(new Error("not exercised")),
        stop: async () => undefined,
      },
      authority: (_value, runId) => authority(runId),
    });
    const controller = new AbortController();
    const abortedRun = aborting({
      ...args,
      rawBody: { execution_id: "aborted" },
      externalSignal: controller.signal,
    });
    await started;
    controller.abort();
    await Bun.sleep(0);
    expect(cancelled).toBe(true);
    expect(startSignal).toBeUndefined();
    releaseStart();
    await expect(abortedRun).rejects.toMatchObject({ code: "unavailable" });

    let eventIndex = 0;
    for (const payload of [
      null,
      { channel: "unknown" },
      {
        channel: "trace_record",
        record: { id: "forged", owner_key_name: "owner" },
      },
    ]) {
      const router = createRuntimeAuthorityRouter(generation);
      const executor = createIsolatedRunExecutor({
        generation,
        workspaceRoot: join(root, "workspace"),
        roots,
        router,
        session: {
          closed: false,
          info,
          async startRun(runId) {
            await router.handlers["host.event"]!({
              method: "host.event",
              generation,
              runId,
              payload,
              signal,
            });
          },
          steer: async () => undefined,
          cancel: async () => undefined,
          exposePort: async () => Promise.reject(new Error("not exercised")),
          stop: async () => undefined,
        },
        authority: (_value, runId) => authority(runId),
      });
      await expect(
        executor({ ...args, rawBody: { execution_id: `event-${eventIndex++}` } }),
      ).rejects.toMatchObject({ code: expect.any(String) });
    }
  });
});
