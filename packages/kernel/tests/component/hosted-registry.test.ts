import { describe, expect, it } from "bun:test";
import type { HostedRunAttachment, RunResult, StartHostedTurnParams } from "@clarvis/protocol";
import {
  createHostedRegistry,
  type HostedRegistryOptions,
  type HostedRegistryState,
} from "../../src/hosting/registry.ts";
import { createHostedProjection, type ProjectionStorage } from "../../src/hosting/projection.ts";
import { createManagedRun, type ManagedRunContext } from "../../src/runs/managed-run.ts";
import { decodeHostedRegistryState } from "../../src/hosting/state.ts";

function input(executionId = "run-1", sessionId = "session-1"): StartHostedTurnParams {
  return {
    session_id: sessionId,
    session_revision: 0,
    kind: "conversation",
    user_preview: "A hosted turn",
    params: { execution_id: executionId, messages: [{ role: "user", content: "A hosted turn" }] },
  };
}

it("persists a plain sanitized preparation error without poisoning later admissions", async () => {
  let attempts = 0;
  const f = fixture({
    prepare: async () => {
      if (attempts++ === 0)
        throw new Error("unknown agent: api_key=secret_example_12345678901234567890");
    },
    commit: async (state) => {
      decodeHostedRegistryState(state);
    },
  });
  const client = f.registry.connect("operator");
  try {
    await expect(client.service.start(input())).rejects.toThrow("unknown agent");
    const [failed] = await client.service.list();
    expect(failed).toMatchObject({ execution_state: "closed", outcome: { status: "failed" } });
    expect(failed?.recovery_error).toBeUndefined();
    expect(Object.keys(failed!.outcome!.error!).sort()).toEqual(["code", "message"]);
    expect(failed!.outcome!.error!.message).not.toContain("secret_example");
    const next = await client.service.start(input("run-2"));
    expect(next.run.execution_id).toBe("run-2");
    f.finish("run-2");
    await next.handle.closed;
    expect(f.starts()).toBe(1);
  } finally {
    await f.registry.close();
  }
});

async function until(condition: () => boolean): Promise<void> {
  for (let step = 0; step < 300 && !condition(); step++) await Promise.resolve();
  expect(condition()).toBe(true);
}

function fixture(
  overrides: {
    prepare?: () => Promise<void>;
    commit?: HostedRegistryOptions["commit"];
    commitIntent?: () => Promise<void>;
    reconcile?: () => Promise<void>;
    detachable?: boolean;
    maxRetainedRuns?: number;
    now?: () => number;
  } = {},
) {
  const contexts = new Map<string, ManagedRunContext>();
  const endings = new Map<string, (value: RunResult) => void>();
  const scopes: string[] = [];
  const retired: string[] = [];
  const commits: HostedRegistryState[] = [];
  const results: RunResult[] = [];
  const removed: string[] = [];
  let starts = 0;
  const registry = createHostedRegistry({
    workspaceId: "workspace",
    hostGeneration: "host-generation",
    owner: "owner",
    now: overrides.now,
    receiptLifetimeMs: 100,
    maxRetainedRuns: overrides.maxRetainedRuns,
    async prepare(value, authority) {
      scopes.push(authority.scope);
      await overrides.prepare?.();
      authority.signal.throwIfAborted();
      return {
        title: "Prepared title",
        config: { agent: "admiral", model: "test/model" },
        detachable: overrides.detachable ?? true,
        async commitIntent() {
          await overrides.commitIntent?.();
        },
        async start() {
          starts++;
          return createManagedRun({
            executionId: value.params.execution_id,
            execute(context) {
              contexts.set(context.executionId, context);
              return new Promise<RunResult>((resolve) => {
                endings.set(context.executionId, resolve);
                context.signal.addEventListener(
                  "abort",
                  () => resolve({ execution_id: context.executionId, status: "cancelled" }),
                  { once: true },
                );
              });
            },
          });
        },
        async reconcile(result) {
          await overrides.reconcile?.();
          results.push(result);
        },
      };
    },
    async projection(executionId) {
      let data = Buffer.alloc(0);
      const storage: ProjectionStorage = {
        async write(bytes, offset) {
          data = Buffer.concat([data.subarray(0, offset), bytes]);
        },
        async read(offset, count) {
          return data.subarray(offset, offset + count);
        },
        async sync() {},
        async close() {},
      };
      return createHostedProjection(storage, {
        execution_id: executionId,
        host_generation: "host-generation",
      });
    },
    async commit(state) {
      await overrides.commit?.(state);
      commits.push(state);
    },
    async removeProjection(id) {
      removed.push(id);
    },
    retireConfigurationSession: (scope) => retired.push(scope),
  });
  const handoff = (view: HostedRunAttachment, operationId = "detach-1") => ({
    execution_id: view.run.execution_id,
    host_generation: view.run.host_generation,
    control_epoch: view.run.control_epoch,
    revision: view.run.revision,
    operation_id: operationId,
  });
  return {
    registry,
    contexts,
    endings,
    scopes,
    retired,
    commits,
    results,
    removed,
    handoff,
    starts: () => starts,
    finish(id = "run-1") {
      endings.get(id)!({ execution_id: id, status: "completed", result: "done" });
    },
  };
}

describe("hosted registry", () => {
  it("retains failed intent ownership until its known preparation is reconciled", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = fixture({
      async commitIntent() {
        throw new Error("intent write failed after publication");
      },
      async reconcile() {
        entered.resolve();
        await release.promise;
      },
    });
    const peer = f.registry.connect("operator");
    const starting = peer.service.start(input());
    const outcome = starting.then(
      () => "started",
      () => "failed",
    );
    await entered.promise;
    expect(f.registry.occupied("session-1")).toBe(true);
    expect(f.starts()).toBe(0);
    release.resolve();
    expect(await outcome).toBe("failed");
    expect(f.registry.occupied("session-1")).toBe(false);
    expect(f.results[0]!.status).toBe("failed");
    await f.registry.close();
  });
  it("reports completion that races a committing handoff without starting another run", async () => {
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = fixture({
      commit: async (state) => {
        if (state.receipts.length > 0) {
          writing.resolve();
          await release.promise;
        }
      },
    });
    const peer = f.registry.connect("operator");
    const view = await peer.service.start(input());
    const moving = peer.service.detach(f.handoff(view));
    await writing.promise;
    f.finish();
    await view.handle.done;
    await until(() => f.results.length === 1);
    release.resolve();
    const receipt = await moving;
    expect(receipt.run.outcome?.status).toBe("completed");
    expect(receipt.run.execution_state).toBe("closed");
    await until(() => !f.registry.occupied("session-1"));
    await peer.service.acknowledge("run-1");
    await peer.service.releaseObservation(view.observation_id);
    expect((await peer.service.receipt("detach-1"))!.run.outcome?.status).toBe("completed");
    expect(f.starts()).toBe(1);
    await f.registry.close();
  });
  it("invalid turn metadata acquires no conversation or execution slot", async () => {
    const f = fixture();
    const peer = f.registry.connect("operator");
    for (const invalid of [
      { ...input(), user_preview: null },
      { ...input(), session_revision: -1 },
      { ...input(), kind: "foreign" },
    ]) {
      await expect(peer.service.start(invalid as unknown as StartHostedTurnParams)).rejects.toThrow(
        "invalid hosted turn",
      );
      expect(f.registry.occupied("session-1")).toBe(false);
    }
    expect(f.starts()).toBe(0);
    await f.registry.close();
  });

  it("can commit handoff with every reader snapshot slot occupied", async () => {
    const f = fixture();
    const peer = f.registry.connect("operator");
    const view = await peer.service.start(input());
    for (let index = 0; index < 3; index++)
      await peer.service.attach({
        execution_id: "run-1",
        host_generation: "host-generation",
        control: "observe",
      });
    const receipt = await peer.service.detach(f.handoff(view));
    expect(receipt.run.disconnect_policy).toBe("continue");
    expect(f.contexts.get("run-1")!.signal.aborted).toBe(false);
    expect(JSON.stringify(f.commits)).not.toContain(f.scopes[0]!);
    await f.registry.close();
  });

  it("bounds concurrent observations across both workspace execution slots", async () => {
    const f = fixture();
    const peer = f.registry.connect("operator");
    await peer.service.start(input());
    await peer.service.start(input("run-2", "session-2"));
    const attached = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        peer.service.attach({
          execution_id: index % 2 === 0 ? "run-1" : "run-2",
          host_generation: "host-generation",
          control: "observe",
        }),
      ),
    );
    expect(attached.filter((item) => item.status === "fulfilled")).toHaveLength(2);
    expect(attached.filter((item) => item.status === "rejected")).toHaveLength(4);
    await f.registry.close();
  });
  it("reserves before async preparation and preserves the shared conversation boundary", async () => {
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    const f = fixture({
      prepare: async () => {
        entered.resolve();
        await gate.promise;
      },
    });
    const first = f.registry.connect("operator");
    const second = f.registry.connect("operator");
    const starting = first.service.start(input());
    await entered.promise;
    expect(f.starts()).toBe(0);
    await expect(second.service.start(input("competing"))).rejects.toThrow("physical work");
    await expect(second.service.reserveActivity("session-1", "shell")).rejects.toThrow(
      "physical work",
    );
    gate.resolve();
    const view = await starting;
    expect(view.run.config).toEqual({ agent: "admiral", model: "test/model" });
    expect(f.commits[0]!.runs[0]!.run.execution_state).toBe("starting");
    await f.registry.close();
    expect(f.starts()).toBe(1);
  });

  it("commits a handoff despite response loss and reconciles it through a new connection", async () => {
    const writing = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = fixture({
      commit: async (state) => {
        if (state.receipts.length > 0) {
          writing.resolve();
          await release.promise;
        }
      },
    });
    const first = f.registry.connect("operator");
    const view = await first.service.start(input());
    const moving = first.service.detach(f.handoff(view));
    await writing.promise;
    expect(f.commits.every((state) => state.receipts.length === 0)).toBe(true);
    const leaving = first.close();
    expect(f.retired).toEqual(f.scopes);
    const second = f.registry.connect("operator");
    expect(await second.service.receipt("detach-1")).toBeNull();
    release.resolve();
    const receipt = await moving;
    await leaving;
    expect(receipt.run.disconnect_policy).toBe("continue");
    expect(await second.service.receipt("detach-1")).toEqual(receipt);
    expect(await second.service.detach(f.handoff(view))).toEqual(receipt);
    const restored = await second.service.attach({
      execution_id: "run-1",
      host_generation: "host-generation",
      control: "acquire",
    });
    expect(restored.run.execution_id).toBe(view.run.execution_id);
    expect(restored.run.control_epoch).toBeGreaterThan(view.run.control_epoch);
    expect(f.starts()).toBe(1);
    expect(f.contexts.get("run-1")!.signal.aborted).toBe(false);
    await second.close();
    expect(f.contexts.get("run-1")!.signal.aborted).toBe(false);
    f.finish();
    await until(() => !f.registry.occupied("session-1"));
    await f.registry.close();
    expect(f.results).toEqual([{ execution_id: "run-1", status: "completed", result: "done" }]);
  });

  it("a failed durable handoff never promotes the run or permits blind mutation replay", async () => {
    const f = fixture({
      commit: async (state) => {
        if (state.receipts.length > 0) throw new Error("disk failure");
      },
    });
    const peer = f.registry.connect("operator");
    const view = await peer.service.start(input());
    await expect(peer.service.detach(f.handoff(view))).rejects.toThrow("disk failure");
    expect((await peer.service.list())[0]!.disconnect_policy).toBe("cancel");
    expect(await peer.service.receipt("detach-1")).toBeNull();
    await expect(peer.service.detach(f.handoff(view))).rejects.toThrow("will not be replayed");
    await peer.close();
    await until(() => !f.registry.occupied("session-1"));
    expect(f.contexts.get("run-1")!.signal.aborted).toBe(true);
    await f.registry.close();
  });

  it("requires explicit takeover, fences old controls and changes volatile guard scope", async () => {
    const f = fixture();
    const first = f.registry.connect("operator");
    const view = await first.service.start(input());
    const previous = f.registry.guardAllowlistFor({ owner: "owner", executionId: "run-1" });
    const second = f.registry.connect("operator");
    await expect(
      second.service.attach({
        execution_id: "run-1",
        host_generation: "host-generation",
        control: "acquire",
      }),
    ).rejects.toThrow("another TUI");
    const next = await second.service.attach({
      execution_id: "run-1",
      host_generation: "host-generation",
      control: "takeover",
    });
    expect(next.run.control).toBe("self");
    expect(f.registry.guardAllowlistFor({ owner: "owner", executionId: "run-1" })).not.toBe(
      previous,
    );
    expect(f.retired).toEqual(f.scopes);
    await expect(view.handle.cancel()).rejects.toThrow("control changed");
    const observer = f.registry.connect("observer");
    const watched = await observer.service.attach({
      execution_id: "run-1",
      host_generation: "host-generation",
      control: "observe",
    });
    await expect(watched.handle.cancel()).rejects.toThrow("lacks control");
    await expect(observer.service.start(input("forbidden", "session-2"))).rejects.toThrow(
      "lacks control",
    );
    await f.registry.close();
  });

  it("rejects native configuration handoff and discards consent when its conversation closes", async () => {
    const f = fixture({ detachable: false });
    const peer = f.registry.connect("operator");
    const view = await peer.service.start(input());
    await expect(peer.service.detach(f.handoff(view))).rejects.toThrow("native configuration");
    await peer.service.closeSession("session-1");
    expect(f.retired).toEqual(f.scopes);
    expect(f.contexts.get("run-1")!.signal.aborted).toBe(true);
    await f.registry.close();
  });

  it("isolates snapshot ownership and reclaims acknowledged results without deleting canonical history", async () => {
    const f = fixture({ maxRetainedRuns: 1 });
    const peer = f.registry.connect("operator");
    const view = await peer.service.start(input());
    const other = f.registry.connect("observer");
    await expect(other.service.readSnapshot(view.snapshot.snapshot_id, 0)).rejects.toThrow(
      "does not belong",
    );
    f.finish();
    await until(() => !f.registry.occupied("session-1"));
    await peer.service.acknowledge("run-1");
    expect(await peer.service.list()).toEqual([]);
    expect(f.registry.stats().retained).toBe(1);
    await peer.service.releaseObservation(view.observation_id);
    expect(f.registry.stats().retained).toBe(0);
    expect(f.removed).toEqual(["run-1"]);
    const next = await peer.service.start(input("run-2"));
    expect(next.run.execution_id).toBe("run-2");
    expect(f.results[0]!.status).toBe("completed");
    await f.registry.close();
  });

  it("receipt expiry returns unknown and cannot reapply the original operation", async () => {
    let stamp = 1;
    const f = fixture({ now: () => stamp });
    const peer = f.registry.connect("operator");
    const view = await peer.service.start(input());
    await peer.service.detach(f.handoff(view));
    stamp += 101;
    expect(await peer.service.receipt("detach-1")).toBeNull();
    await expect(peer.service.detach(f.handoff(view))).rejects.toThrow("will not be replayed");
    await f.registry.close();
  });
});
