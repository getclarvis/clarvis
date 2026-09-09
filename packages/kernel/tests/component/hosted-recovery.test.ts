import { describe, expect, test } from "bun:test";
import type { HostedRunRef, HostedRecoveryResolution } from "@clarvis/protocol";
import { createHostedRegistry, type HostedRegistryState } from "../../src/hosting/registry.ts";
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

function fixture(initialState = state()) {
  const commits: HostedRegistryState[] = [];
  const removed: Array<[string, string]> = [];
  const audits: HostedRecoveryResolution[] = [];
  let rejectCommit = false;
  let archiveGate: Promise<void> | undefined;
  const registry = createHostedRegistry({
    workspaceId: "workspace",
    hostGeneration: "current",
    owner: "owner",
    initialState,
    now: () => 20,
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
    async removeProjection(id, generation) {
      removed.push([id, generation]);
    },
    retireConfigurationSession() {},
  });
  return {
    gateArchive: (gate: Promise<void>) => {
      archiveGate = gate;
    },
    registry,
    commits,
    removed,
    audits,
    failCommit: (value: boolean) => {
      rejectCommit = value;
    },
  };
}

describe("host generation recovery", () => {
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
        retireConfigurationSession: () => {},
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
      expect(
        f.registry.guardAllowlistFor({ executionId: "interrupted", owner: "owner" }),
      ).toBeUndefined();
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
