import { describe, expect, test } from "bun:test";
import type { HostedRunRef, HostedRecoveryResolution } from "@clarvis/protocol";
import {
  createHostedRegistry,
  type HostedRegistryState,
  type HostedRegistryOptions,
} from "../../src/hosting/registry.ts";
import { kernelError } from "../../src/core/errors.ts";
import { decodeHostedRegistryState } from "../../src/hosting/state.ts";

function ref(id: string, state: HostedRunRef["execution_state"]): HostedRunRef {
  return {
    execution_id: id,
    session_id: `session-${id}`,
    workspace_id: "workspace",
    host_generation: "previous",
    title: id,
    config: { agent: "solo", model: "test/model" },
    created_at: 1,
    updated_at: 10,
    revision: 4,
    control_epoch: 2,
    control: "self",
    disconnect_policy: "continue",
    execution_state: state,
    attention: "waiting_user",
    ...(state === "closed" ? { outcome: { status: "completed" as const } } : {}),
  };
}

function state(): HostedRegistryState {
  return {
    schema_version: 1,
    host_generation: "previous",
    runs: [
      { run: ref("complete", "closed"), acknowledged: false },
      { run: ref("interrupted", "running"), acknowledged: false },
    ],
    receipts: [
      {
        receipt: { operation_id: "handoff", run: ref("complete", "closed"), committed_at: 10 },
        expires_at: 100,
      },
    ],
  };
}

function fixture(
  initialState = state(),
  settlementReconciled?: (run: HostedRunRef) => Promise<boolean>,
  deliverOperator?: (session: string, intent: string, execution: string) => Promise<void>,
  deliveryReconciled?: (session: string, intent: string, execution: string) => Promise<boolean>,
  recoverSettlement?: HostedRegistryOptions["recoverSettlement"],
  clock: () => number = () => 20,
  scheduleRecovery?: HostedRegistryOptions["scheduleRecovery"],
  discoverDeliveries?: HostedRegistryOptions["discoverDeliveries"],
) {
  const commits: HostedRegistryState[] = [];
  const removed: Array<[string, string]> = [];
  const audits: HostedRecoveryResolution[] = [];
  const continues: string[] = [];
  let rejectCommit = false;
  let archiveGate: Promise<void> | undefined;
  const registry = createHostedRegistry({
    workspaceId: "workspace",
    hostGeneration: "current",
    owner: "owner",
    initialState,
    settlementReconciled,
    recoverSettlement,
    deliverOperator,
    deliveryReconciled,
    discoverDeliveries,
    async recoveryWait() {},
    now: clock,
    scheduleRecovery,
    async prepare() {
      throw new Error("recovery must never prepare execution");
    },
    async projection() {
      throw new Error("recovery must never open a live projection");
    },
    async commit(value) {
      if (rejectCommit) throw new Error("index write failed");
      commits.push(value);
    },
    async archiveRecovery(_run, resolution) {
      audits.push(structuredClone(resolution));
      await archiveGate;
      return structuredClone(resolution);
    },
    async continueRecovery(run) {
      continues.push(run.execution_id);
    },
    async removeProjection(id, generation) {
      removed.push([id, generation]);
    },
  });
  return {
    gateArchive: (gate: Promise<void>) => {
      archiveGate = gate;
    },
    registry,
    commits,
    removed,
    audits,
    continues,
    failCommit: (value: boolean) => {
      rejectCommit = value;
    },
  };
}

describe("host generation recovery", () => {
  test("discovers a lost steering checkpoint after restart and reconciles without replay", async () => {
    let consumed = false;
    let writes = 0;
    const f = fixture(
      state(),
      undefined,
      async (_session, intent, execution) => {
        expect(intent).toBe("steer_recovered");
        expect(execution).toBe("complete");
        expect(f.commits.at(-1)!.runs[0]!.deliveries![0]).toMatchObject({
          intent_id: intent,
          state: "ready",
          attempt: 1,
        });
        writes++;
        consumed = true;
      },
      async () => consumed,
      undefined,
      undefined,
      undefined,
      async (run) => {
        if (run.execution_id === "interrupted") throw kernelError("unavailable", "missing index");
        return consumed ? [] : ["steer_recovered"];
      },
    );
    try {
      await f.registry.sync();
      await f.registry.sync();
      expect(writes).toBe(1);
      expect(f.commits.at(-1)!.runs[0]!.deliveries).toBeUndefined();
      expect(f.registry.occupied("session-interrupted")).toBe(true);
      expect(f.registry.occupied("session-complete")).toBe(false);
    } finally {
      await f.registry.close();
    }
  });

  test.each([false, true])(
    "future backoff releases sync and wakes its owner, crossing eligibility during sync: %s",
    async (crossesDeadline) => {
      let now = 20;
      const timers: Array<{ delay: number; wake(): void; cancelled: boolean }> = [];
      const repaired: string[] = [];
      const initial = state();
      initial.runs = ["future", "ready"].map((id) => ({
        run: { ...ref(id, "finishing"), outcome: { status: "completed" as const } },
        acknowledged: false,
        settlement: {
          operation: "reconcile",
          state: "recovering",
          attempt: 1,
          physical_closed: true,
          controller_epoch: 2,
          ...(id === "future" ? { next_attempt_at: 200 } : {}),
        },
      }));
      const f = fixture(
        initial,
        async () => false,
        undefined,
        undefined,
        async (run) => {
          repaired.push(run.execution_id);
          if (crossesDeadline && run.execution_id === "ready") now = 200;
          return true;
        },
        () => now,
        (delay, wake) => {
          const timer = { delay, wake, cancelled: false };
          timers.push(timer);
          return () => {
            timer.cancelled = true;
          };
        },
      );
      try {
        await f.registry.sync();
        expect(repaired).toEqual(["ready"]);
        expect(f.registry.occupied("session-ready")).toBe(false);
        expect(f.registry.occupied("session-future")).toBe(true);
        expect(timers).toHaveLength(1);
        expect(timers[0]!.delay).toBe(crossesDeadline ? 0 : 180);
        if (!crossesDeadline) {
          await f.registry.sync();
          expect(timers[0]!.cancelled).toBe(true);
          expect(repaired).toEqual(["ready"]);
        }
        now = 200;
        timers.at(-1)!.wake();
        await f.registry.sync();
        expect(repaired).toEqual(["ready", "future"]);
        expect(f.registry.occupied("session-future")).toBe(false);
      } finally {
        await f.registry.close();
      }
    },
  );

  test("closing cancels a future delivery wake and prevents late recovery", async () => {
    let wake: (() => void) | undefined;
    let cancelled = false;
    let deliveries = 0;
    const initial = state();
    initial.runs[0]!.deliveries = [
      {
        intent_id: "steer_future",
        controller_epoch: 2,
        state: "recovering",
        attempt: 1,
        next_attempt_at: 200,
      },
    ];
    const f = fixture(
      initial,
      undefined,
      async () => {
        deliveries++;
      },
      async () => false,
      undefined,
      () => 20,
      (_delay, callback) => {
        wake = callback;
        return () => {
          cancelled = true;
        };
      },
    );
    try {
      await f.registry.sync();
      expect(deliveries).toBe(0);
      expect(wake).toBeDefined();
      await f.registry.close();
      expect(cancelled).toBe(true);
      const commits = f.commits.length;
      wake!();
      await f.registry.sync();
      expect(f.commits).toHaveLength(commits);
      expect(deliveries).toBe(0);
    } finally {
      await f.registry.close();
    }
  });

  test("restart reconciles durable consumption receipts without starting or restoring authority", async () => {
    const initial = state();
    initial.runs[1]!.deliveries = [
      { intent_id: "steer_pending", controller_epoch: 2, state: "recovering", attempt: 1 },
    ];
    const delivered: string[] = [];
    const f = fixture(
      decodeHostedRegistryState(initial),
      undefined,
      async (session, intent, execution) => {
        delivered.push(`${session}:${intent}:${execution}`);
      },
    );
    try {
      await f.registry.sync();
      expect(delivered).toEqual(["session-interrupted:steer_pending:interrupted"]);
      expect(f.commits.at(-1)!.runs[1]!.deliveries).toBeUndefined();
      expect(f.registry.occupied("session-interrupted")).toBe(true);
      await f.registry.sync();
      expect(delivered).toHaveLength(1);
    } finally {
      await f.registry.close();
    }
  });

  test("canonical consumption proof repairs an exhausted receipt without another write", async () => {
    const initial = state();
    initial.runs[0]!.deliveries = [
      {
        intent_id: "steer_pending",
        controller_epoch: 2,
        state: "waiting_external",
        attempt: 3,
        cause: "receipt_unconfirmed",
      },
    ];
    let checks = 0;
    const f = fixture(
      initial,
      undefined,
      async () => {
        throw new Error("must not repeat receipt write");
      },
      async (_session, intent, execution) => {
        checks++;
        expect(intent).toBe("steer_pending");
        expect(execution).toBe("complete");
        return true;
      },
    );
    try {
      f.failCommit(true);
      await expect(f.registry.sync()).rejects.toThrow("index write failed");
      f.failCommit(false);
      await f.registry.sync();
      expect(checks).toBe(2);
      expect(f.commits.at(-1)!.runs[0]!.deliveries).toBeUndefined();
    } finally {
      await f.registry.close();
    }
  });

  test("a permanent delivery proof failure waits locally without rewriting consumption", async () => {
    const initial = state();
    for (const entry of initial.runs)
      entry.deliveries = [
        {
          intent_id: `steer_${entry.run.execution_id}`,
          controller_epoch: 2,
          state: "ready",
          attempt: 0,
        },
      ];
    let restored = false;
    let writes = 0;
    const f = fixture(
      initial,
      undefined,
      async () => {
        writes++;
      },
      async (_session, _intent, execution) => {
        if (execution === "complete" && !restored)
          throw kernelError("conflict", "injected receipt lookup failure");
        return true;
      },
    );
    try {
      await f.registry.sync();
      expect(f.commits.at(-1)!.runs[0]!.deliveries?.[0]).toMatchObject({
        state: "waiting_external",
        cause: "operation_failed",
        attempt: 0,
      });
      expect(f.commits.at(-1)!.runs[1]!.deliveries).toBeUndefined();
      await f.registry.sync();
      expect(writes).toBe(0);
      restored = true;
      await f.registry.sync();
      expect(f.commits.at(-1)!.runs[0]!.deliveries).toBeUndefined();
      expect(writes).toBe(0);
    } finally {
      await f.registry.close();
    }
  });

  test("pending receipt identities are bounded and cannot repeat within a run", () => {
    const initial = state();
    const receipt = {
      intent_id: "steer_pending",
      controller_epoch: 2,
      state: "ready" as const,
      attempt: 0,
    };
    initial.runs[0]!.deliveries = [receipt, receipt];
    expect(() => decodeHostedRegistryState(initial)).toThrow("duplicate identities");
    initial.runs[0]!.deliveries = Array.from({ length: 17 }, (_, index) => ({
      ...receipt,
      intent_id: `steer_${index}`,
    }));
    expect(() => decodeHostedRegistryState(initial)).toThrow("invalid");
  });

  test("repairs missing canonical settlement before releasing occupancy and coalesces restart synchronization", async () => {
    const initial = state();
    initial.runs[1]!.run.execution_state = "finishing";
    initial.runs[1]!.run.outcome = { status: "completed" };
    initial.runs[1]!.settlement = {
      operation: "reconcile",
      state: "ready",
      attempt: 1,
      physical_closed: true,
      controller_epoch: 2,
    };
    let canonical = false;
    let repairs = 0;
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const f = fixture(
      initial,
      async () => canonical,
      undefined,
      undefined,
      async (run, checkpoint) => {
        repairs++;
        expect(run.execution_id).toBe("interrupted");
        expect(checkpoint.physical_closed).toBe(true);
        entered.resolve();
        await release.promise;
        canonical = true;
        return true;
      },
    );
    try {
      f.failCommit(true);
      const first = f.registry.sync();
      const second = f.registry.sync();
      const results = Promise.allSettled([first, second]);
      await entered.promise;
      expect(f.registry.occupied("session-interrupted")).toBe(true);
      release.resolve();
      expect((await results).map((result) => result.status)).toEqual(["rejected", "rejected"]);
      expect(repairs).toBe(1);
      expect(f.registry.occupied("session-interrupted")).toBe(true);
      f.failCommit(false);
      await f.registry.sync();
      expect(repairs).toBe(1);
      expect(f.registry.occupied("session-interrupted")).toBe(false);
      expect(f.commits.at(-1)!.runs[1]!.run.execution_state).toBe("closed");
    } finally {
      release.resolve();
      await f.registry.close();
    }
  });

  test("restart repair failures remain scoped and exhaust their persisted allowance", async () => {
    for (const code of ["unavailable", "conflict"] as const) {
      const initial = state();
      initial.runs[1]!.run.execution_state = "finishing";
      initial.runs[1]!.run.outcome = { status: "completed" };
      initial.runs[1]!.settlement = {
        operation: "reconcile",
        state: "ready",
        attempt: 1,
        physical_closed: true,
        controller_epoch: 2,
      };
      let attempts = 0;
      const f = fixture(
        initial,
        async () => false,
        undefined,
        undefined,
        async () => {
          attempts++;
          throw kernelError(code, "injected canonical failure");
        },
      );
      try {
        await f.registry.sync();
        await f.registry.sync();
        expect(attempts).toBe(code === "unavailable" ? 3 : 1);
        expect(f.registry.occupied("session-interrupted")).toBe(true);
        expect(f.registry.occupied("session-complete")).toBe(false);
        expect(f.commits.at(-1)!.runs[1]!.settlement).toMatchObject({
          state: "waiting_external",
          cause: code === "unavailable" ? "storage_unavailable" : "operation_failed",
        });
      } finally {
        await f.registry.close();
      }
    }
  });

  test.each(["unavailable", "conflict"] as const)(
    "contains %s proof lookup failure without preventing another session from recovering",
    async (code) => {
      const initial = state();
      initial.runs = ["unreadable", "healthy"].map((id) => ({
        run: { ...ref(id, "finishing"), outcome: { status: "completed" as const } },
        acknowledged: false,
        settlement: {
          operation: "reconcile",
          state: "ready",
          attempt: 1,
          physical_closed: true,
          controller_epoch: 2,
        },
      }));
      let repaired = false;
      let lookups = 0;
      let writes = 0;
      const f = fixture(
        initial,
        async (run) => {
          if (run.execution_id === "healthy" || repaired) return true;
          lookups++;
          throw kernelError(code, "injected proof read failure");
        },
        undefined,
        undefined,
        async () => {
          writes++;
          return true;
        },
      );
      try {
        await f.registry.sync();
        expect(lookups).toBe(code === "unavailable" ? 3 : 1);
        expect(writes).toBe(0);
        expect(f.registry.occupied("session-unreadable")).toBe(true);
        expect(f.registry.occupied("session-healthy")).toBe(false);
        const exhausted = f.commits
          .at(-1)!
          .runs.find((entry) => entry.run.execution_id === "unreadable")!.settlement;
        expect(exhausted).toMatchObject({
          state: "waiting_external",
          cause: code === "unavailable" ? "storage_unavailable" : "operation_failed",
        });
        await f.registry.sync();
        expect(lookups).toBe(code === "unavailable" ? 4 : 2);
        expect(
          f.commits.at(-1)!.runs.find((entry) => entry.run.execution_id === "unreadable")!
            .settlement,
        ).toEqual(exhausted);
        repaired = true;
        await f.registry.sync();
        expect(f.registry.occupied("session-unreadable")).toBe(false);
        expect(writes).toBe(0);
      } finally {
        await f.registry.close();
      }
    },
  );

  test("reconciles a lost session acknowledgement before releasing old-generation occupancy", async () => {
    const initial = state();
    initial.runs[1]!.run.execution_state = "finishing";
    initial.runs[1]!.run.outcome = { status: "completed" };
    initial.runs[1]!.settlement = {
      operation: "reconcile",
      state: "ready",
      attempt: 1,
      physical_closed: true,
      controller_epoch: 2,
    };
    const inspected: string[] = [];
    const f = fixture(initial, async (run) => {
      inspected.push(run.execution_id);
      return true;
    });
    try {
      f.failCommit(true);
      await expect(f.registry.sync()).rejects.toThrow("index write failed");
      expect(f.registry.occupied("session-interrupted")).toBe(true);
      f.failCommit(false);
      await f.registry.sync();
      expect(inspected).toEqual(["interrupted", "interrupted"]);
      expect(f.registry.occupied("session-interrupted")).toBe(false);
      expect(f.audits).toEqual([]);
      expect(f.commits.at(-1)!.runs[1]!.settlement?.operation).toBe("commit_terminal");
    } finally {
      await f.registry.close();
    }
  });

  test("recovers only a durable physically closed and reconciled settlement without operator attestation", async () => {
    for (const operation of ["reconcile", "commit_terminal"] as const) {
      const initial = state();
      initial.runs[1]!.run.execution_state = "finishing";
      initial.runs[1]!.run.outcome = { status: "completed" };
      initial.runs[1]!.settlement = {
        operation,
        state: "ready",
        attempt: 1,
        physical_closed: true,
        controller_epoch: 2,
      };
      const f = fixture(initial);
      try {
        await f.registry.sync();
        const peer = f.registry.connect("operator");
        const row = (await peer.service.list()).find(
          (item) => item.execution_id === "interrupted",
        )!;
        expect(row.execution_state).toBe(operation === "commit_terminal" ? "closed" : "unknown");
        expect(f.registry.occupied(row.session_id)).toBe(operation === "reconcile");
        expect(f.audits).toEqual([]);
        expect(
          f.commits.at(-1)!.runs.find((item) => item.run.execution_id === row.execution_id)!.run
            .execution_state,
        ).toBe(row.execution_state);
      } finally {
        await f.registry.close();
      }
    }
  });

  test("coalesces confirmations and awaits the durable session audit during shutdown", async () => {
    const f = fixture();
    const gate = Promise.withResolvers<void>();
    f.gateArchive(gate.promise);
    try {
      const peer = f.registry.connect("operator");
      const row = (await peer.service.list()).find(
        (value) => value.execution_id === "interrupted",
      )!;
      const input = {
        execution_id: row.execution_id,
        host_generation: row.host_generation,
        revision: row.revision,
        physical_work_stopped: true as const,
      };
      const first = peer.service.resolveRecovery(input);
      const second = peer.service.resolveRecovery(input);
      expect(f.audits).toHaveLength(1);
      expect(f.commits).toHaveLength(0);
      expect(f.registry.stats().unresolved).toBe(1);
      let closed = false;
      const close = f.registry.close().then(() => {
        closed = true;
      });
      await Bun.sleep(0);
      expect(closed).toBe(false);
      gate.resolve();
      const [a, b] = await Promise.all([first, second]);
      expect(a.recovery_resolution).toEqual(b.recovery_resolution);
      await close;
      expect(closed).toBe(true);
      expect(f.commits).toHaveLength(1);
    } finally {
      gate.resolve();
      await f.registry.close();
    }
  });

  test("releases the resolved conversation only for an explicit continue disposition", async () => {
    const f = fixture();
    try {
      const peer = f.registry.connect("operator");
      const row = (await peer.service.list()).find(
        (value) => value.execution_id === "interrupted",
      )!;
      const input = {
        execution_id: row.execution_id,
        host_generation: row.host_generation,
        revision: row.revision,
        physical_work_stopped: true as const,
        disposition: "continue" as const,
      };
      await expect(
        peer.service.resolveRecovery({ ...input, disposition: "park" as never }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(f.audits).toEqual([]);
      expect(f.continues).toEqual([]);

      const resolved = await peer.service.resolveRecovery(input);
      expect(resolved.recovery_resolution).toMatchObject({ disposition: "continue" });
      // The durable attestation comes first, then the conversation's own release.
      expect(f.audits).toHaveLength(1);
      expect(f.continues).toEqual([row.execution_id]);
      expect(resolved.execution_state).toBe("closed");
      expect(resolved.outcome).toBeUndefined();
    } finally {
      await f.registry.close();
    }
  });

  test("requires operator confirmation and an exact revision before releasing unknown physical work", async () => {
    const f = fixture();
    try {
      const peer = f.registry.connect("operator");
      const observer = f.registry.connect("observer");
      const row = (await peer.service.list()).find(
        (value) => value.execution_id === "interrupted",
      )!;
      const input = {
        execution_id: row.execution_id,
        host_generation: row.host_generation,
        revision: row.revision,
        physical_work_stopped: true as const,
      };
      await expect(observer.service.resolveRecovery(input)).rejects.toMatchObject({
        code: "unauthorized",
      });
      await expect(
        peer.service.resolveRecovery({ ...input, physical_work_stopped: false as true }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(peer.service.resolveRecovery({ ...input, revision: 0 })).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(
        peer.service.resolveRecovery({ ...input, host_generation: "current" }),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(f.audits).toHaveLength(0);
      const resolved = await peer.service.resolveRecovery(input);
      expect(resolved.execution_state).toBe("closed");
      expect(resolved.outcome).toBeUndefined();
      // The default disposition parks the work; only an explicit continue resumes the conversation.
      expect(resolved.recovery_resolution).toMatchObject({ disposition: "archive" });
      expect(f.continues).toEqual([]);
      expect(resolved.recovery_resolution).toMatchObject({
        previous_host_generation: "previous",
        resolving_host_generation: "current",
        operator_connection_id: peer.peer.id,
      });
      expect(f.registry.stats().unresolved).toBe(0);
      expect(f.registry.occupied(row.session_id)).toBe(false);
      const persisted = f.commits.at(-1)!;
      expect(
        persisted.runs.find((item) => item.run.execution_id === row.execution_id)!.run
          .recovery_resolution,
      ).toEqual(resolved.recovery_resolution);
      const restarted = createHostedRegistry({
        workspaceId: "workspace",
        hostGeneration: "next",
        owner: "owner",
        initialState: persisted,
        prepare: async () => {
          throw new Error("no replay");
        },
        projection: async () => {
          throw new Error("no live projection");
        },
        commit: async () => {},
        removeProjection: async () => {},
      });
      expect(restarted.stats().unresolved).toBe(0);
      await restarted.close();
      await peer.service.acknowledge(row.execution_id);
      expect(f.removed).toEqual([[row.execution_id, "previous"]]);
      expect(f.audits).toHaveLength(1);
    } finally {
      await f.registry.close();
    }
  });

  test("retains uncertainty when publishing the recovery index fails", async () => {
    const f = fixture();
    try {
      const peer = f.registry.connect("operator");
      const row = (await peer.service.list()).find(
        (value) => value.execution_id === "interrupted",
      )!;
      const input = {
        execution_id: row.execution_id,
        host_generation: row.host_generation,
        revision: row.revision,
        physical_work_stopped: true as const,
      };
      f.failCommit(true);
      await expect(peer.service.resolveRecovery(input)).rejects.toThrow("index write failed");
      expect(f.registry.stats().unresolved).toBe(1);
      expect(
        (await peer.service.list()).find((value) => value.execution_id === row.execution_id)!
          .execution_state,
      ).toBe("unknown");
      f.failCommit(false);
      expect((await peer.service.resolveRecovery(input)).execution_state).toBe("closed");
      expect(f.registry.stats().unresolved).toBe(0);
    } finally {
      f.failCommit(false);
      await f.registry.close();
    }
  });

  test("preserves terminal history and handoff receipts without restoring controls or execution", async () => {
    const f = fixture();
    try {
      const peer = f.registry.connect("operator");
      const rows = await peer.service.list();
      expect(rows[0]).toMatchObject({
        host_generation: "previous",
        execution_state: "closed",
        control: "available",
        attention: "none",
      });
      expect(rows[1]).toMatchObject({
        execution_state: "unknown",
        control: "available",
        attention: "none",
      });
      expect(rows[1]!.recovery_error).toContain("cannot be resumed");
      expect(f.registry.occupied("session-interrupted")).toBe(true);
      expect(f.registry.occupied("session-complete")).toBe(false);
      expect((await peer.service.receipt("handoff"))!.run.outcome!.status).toBe("completed");
      for (const generation of ["previous", "current"]) {
        await expect(
          peer.service.attach({
            execution_id: "interrupted",
            host_generation: generation,
            control: "takeover",
          }),
        ).rejects.toMatchObject({ code: "conflict" });
      }
      await expect(
        peer.service.reserveActivity("session-interrupted", "shell"),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        peer.service.start({
          session_id: "session-interrupted",
          session_revision: 0,
          kind: "conversation",
          user_preview: "Do not replay",
          params: {
            execution_id: "another",
            messages: [{ role: "user", content: "Do not replay" }],
          },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(peer.service.acknowledge("interrupted")).rejects.toMatchObject({
        code: "conflict",
      });
      await peer.service.acknowledge("complete");
      expect(f.removed).toEqual([["complete", "previous"]]);
      await f.registry.sync();
      expect(f.commits.at(-1)!.host_generation).toBe("current");
      expect(f.commits.at(-1)!.runs[0]!.run.execution_state).toBe("unknown");
      expect(f.registry.stats()).toMatchObject({ runs: 0, unresolved: 1, committing: 0 });
    } finally {
      await f.registry.close();
    }
  });

  test("rejects corrupt, foreign and oversized indexes before acquiring any live authority", () => {
    const duplicate = state();
    duplicate.runs.push(duplicate.runs[0]!);
    expect(() => decodeHostedRegistryState(duplicate)).toThrow("duplicate");
    expect(() => decodeHostedRegistryState({ ...state(), schema_version: 2 })).toThrow("invalid");
    expect(() =>
      decodeHostedRegistryState({ ...state(), credential: "must-not-be-accepted" }),
    ).toThrow("invalid");
    const large = state();
    large.runs[0]!.run.recovery_error = "x".repeat(2 * 1024 * 1024);
    expect(() => decodeHostedRegistryState(large)).toThrow("2 MiB");
    const foreign = state();
    foreign.runs[0]!.run.workspace_id = "other-workspace";
    expect(() => fixture(foreign)).toThrow("another workspace");
    expect(() => fixture({ ...state(), host_generation: "current" })).toThrow("fresh generation");
  });

  test("expired receipts remain unknown and cannot authorize a replay in a new generation", async () => {
    const initial = state();
    initial.receipts[0]!.expires_at = 10;
    const f = fixture(initial);
    try {
      const peer = f.registry.connect("operator");
      expect(await peer.service.receipt("handoff")).toBeNull();
      await expect(
        peer.service.detach({
          execution_id: "complete",
          host_generation: "previous",
          operation_id: "handoff",
          control_epoch: 2,
          revision: 4,
        }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await f.registry.close();
    }
  });
});
