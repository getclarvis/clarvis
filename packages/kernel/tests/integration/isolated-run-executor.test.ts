import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOME_ENV } from "@clarvis/paths";
import {
  createCapabilityBroker,
  createIsolatedRunExecutor,
  createModelBroker,
  createRuntimeAuthorityRouter,
  type RuntimeInfo,
  type RuntimeSession,
} from "../../src/index.ts";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("isolated run executor", () => {
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
      settleWorkspace: async () => {
        calls.push("workspace_review");
      },
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
          (["session", "trace", "capabilities", "workspace"] as const).map((name) => ({
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
    expect(calls).toEqual(["workspace_review", "session", "trace", "capabilities", "workspace"]);
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
        info,
        startRun: async () => null,
        steer: async () => undefined,
        cancel: async () => undefined,
        exposePort: async () => Promise.reject(new Error("not exercised")),
        stop: async () => undefined,
      },
      authority: (_value, runId) => authority(runId),
      settleWorkspace: async () => undefined,
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
        info,
        startRun: async (runId) => ({ executionId: runId, response: { status: "done" } }),
        steer: async () => undefined,
        cancel: async () => undefined,
        exposePort: async () => Promise.reject(new Error("not exercised")),
        stop: async () => undefined,
      },
      authority: (_value, runId) => authority(runId),
      settleWorkspace: async () => undefined,
    });
    await expect(
      noCheckpoint({ ...args, rawBody: { execution_id: "no-checkpoint" } }),
    ).rejects.toMatchObject({ code: "unavailable" });

    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => (releaseStart = resolve));
    let cancelled = false;
    const abortRouter = createRuntimeAuthorityRouter(generation);
    const aborting = createIsolatedRunExecutor({
      generation,
      workspaceRoot: join(root, "workspace"),
      roots,
      router: abortRouter,
      session: {
        info,
        async startRun() {
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
      settleWorkspace: async () => undefined,
    });
    const controller = new AbortController();
    const abortedRun = aborting({
      ...args,
      rawBody: { execution_id: "aborted" },
      externalSignal: controller.signal,
    });
    controller.abort();
    await Bun.sleep(0);
    expect(cancelled).toBe(true);
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
        settleWorkspace: async () => undefined,
      });
      await expect(
        executor({ ...args, rawBody: { execution_id: `event-${eventIndex++}` } }),
      ).rejects.toMatchObject({ code: expect.any(String) });
    }
  });
});
