import { describe, expect, test } from "bun:test";
import type { HostedRunRef } from "@clarvis/protocol";
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
      commits.push(value);
    },
    async removeProjection(id, generation) {
      removed.push([id, generation]);
    },
    retireConfigurationSession() {},
  });
  return { registry, commits, removed };
}

describe("host generation recovery", () => {
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
