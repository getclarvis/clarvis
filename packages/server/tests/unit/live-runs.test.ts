import { describe, it, expect } from "bun:test";
import { recordingLoggers } from "../helpers/harness.ts";
import {
  createConcurrencyGate,
  createLiveRunTable,
  type LiveRun,
} from "../../src/host/live-runs.ts";
import { ServerError } from "../../src/mcp/errors.ts";

function fakeRun(executionId: string, owner = "alice"): LiveRun {
  return {
    executionId,
    owner,
    handle: {} as LiveRun["handle"],
    startedAt: Date.now(),
    elicit: {} as LiveRun["elicit"],
    lifecycleDone: Promise.resolve(),
  };
}

describe("createLiveRunTable", () => {
  it("adds and retrieves a run by id", () => {
    const runs = createLiveRunTable();
    const run = fakeRun("run-1");
    runs.add(run);
    expect(runs.get("run-1")).toBe(run);
    expect(runs.size).toBe(1);
  });

  it("get returns undefined for an unknown id", () => {
    const runs = createLiveRunTable();
    expect(runs.get("nope")).toBeUndefined();
  });

  it("throws a conflict ServerError when adding a duplicate id", () => {
    const runs = createLiveRunTable();
    runs.add(fakeRun("run-1"));
    try {
      runs.add(fakeRun("run-1"));
      throw new Error("expected add to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      const serverErr = err as ServerError;
      expect(serverErr.code).toBe("conflict");
      expect(serverErr.message).toMatch(/already in flight/);
      expect(serverErr.details).toEqual({ execution_id: "run-1" });
    }
  });

  it("require returns the run when present", () => {
    const runs = createLiveRunTable();
    const run = fakeRun("run-1");
    runs.add(run);
    expect(runs.require("run-1")).toBe(run);
  });

  it("require throws a not_found ServerError when absent", () => {
    const runs = createLiveRunTable();
    try {
      runs.require("missing");
      throw new Error("expected require to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      const serverErr = err as ServerError;
      expect(serverErr.code).toBe("not_found");
      expect(serverErr.message).toMatch(/no live run 'missing'/);
      expect(serverErr.details).toEqual({ execution_id: "missing" });
    }
  });

  it("delete removes a run and is a no-op for an unknown id", () => {
    const runs = createLiveRunTable();
    runs.add(fakeRun("run-1"));
    runs.delete("run-1");
    expect(runs.get("run-1")).toBeUndefined();
    expect(runs.size).toBe(0);
    expect(() => runs.delete("never-added")).not.toThrow();
  });

  it("values returns a snapshot array that does not alias later mutation", () => {
    const runs = createLiveRunTable();
    runs.add(fakeRun("run-1"));
    runs.add(fakeRun("run-2"));
    const snapshot = runs.values();
    expect(snapshot.map((r) => r.executionId).sort()).toEqual(["run-1", "run-2"]);
    runs.add(fakeRun("run-3"));
    expect(snapshot).toHaveLength(2);
  });
});

describe("createConcurrencyGate", () => {
  it("tracks total and per-owner in-flight counts across acquire/release", () => {
    const gate = createConcurrencyGate({ perOwner: 5, global: 5 });
    expect(gate.total).toBe(0);
    expect(gate.inFlight("alice")).toBe(0);

    const release1 = gate.acquire("alice");
    const release2 = gate.acquire("alice");
    expect(gate.total).toBe(2);
    expect(gate.inFlight("alice")).toBe(2);

    release1();
    expect(gate.total).toBe(1);
    expect(gate.inFlight("alice")).toBe(1);

    release2();
    expect(gate.total).toBe(0);
    expect(gate.inFlight("alice")).toBe(0);
  });

  it("release is idempotent when called more than once", () => {
    const gate = createConcurrencyGate({ perOwner: 5, global: 5 });
    const release = gate.acquire("alice");
    release();
    release();
    expect(gate.total).toBe(0);
    expect(gate.inFlight("alice")).toBe(0);
  });

  it("throws a resource_exhausted ServerError at the server-wide limit", () => {
    const gate = createConcurrencyGate({ perOwner: 10, global: 1 });
    gate.acquire("alice");
    try {
      gate.acquire("bob");
      throw new Error("expected acquire to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      const serverErr = err as ServerError;
      expect(serverErr.code).toBe("resource_exhausted");
      expect(serverErr.message).toMatch(/concurrent-run limit/);
      expect(serverErr.details).toEqual({
        reason: "concurrency_limit",
        scope: "server",
        in_flight: 1,
        limit: 1,
      });
    }
    expect(gate.total).toBe(1);
  });

  it("throws a resource_exhausted ServerError at the per-owner limit without touching the global count", () => {
    const gate = createConcurrencyGate({ perOwner: 1, global: 10 });
    gate.acquire("alice");
    try {
      gate.acquire("alice");
      throw new Error("expected acquire to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ServerError);
      const serverErr = err as ServerError;
      expect(serverErr.code).toBe("resource_exhausted");
      expect(serverErr.message).toMatch(/this owner is at its concurrent-run limit/);
      expect(serverErr.details).toEqual({
        reason: "concurrency_limit",
        scope: "owner",
        in_flight: 1,
        limit: 1,
      });
    }
    expect(gate.total).toBe(1);
    expect(gate.inFlight("alice")).toBe(1);

    gate.acquire("bob");
    expect(gate.total).toBe(2);
    expect(gate.inFlight("bob")).toBe(1);
  });

  it("uses a role cap only to narrow the operator's per-owner limit", () => {
    const narrowed = createConcurrencyGate({ perOwner: 4, global: 10 });
    narrowed.acquire("alice", 1);
    expect(() => narrowed.acquire("alice", 1)).toThrow(/owner is at its concurrent-run limit/);

    const bounded = createConcurrencyGate({ perOwner: 1, global: 10 });
    bounded.acquire("alice", 99);
    try {
      bounded.acquire("alice", 99);
      throw new Error("expected acquire to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ServerError);
      expect((error as ServerError).details).toMatchObject({ scope: "owner", limit: 1 });
    }
  });

  it("keeps owner counts independent", () => {
    const gate = createConcurrencyGate({ perOwner: 1, global: 10 });
    const releaseAlice = gate.acquire("alice");
    const releaseBob = gate.acquire("bob");
    expect(gate.inFlight("alice")).toBe(1);
    expect(gate.inFlight("bob")).toBe(1);
    expect(gate.total).toBe(2);

    releaseAlice();
    expect(gate.inFlight("alice")).toBe(0);
    expect(gate.inFlight("bob")).toBe(1);

    releaseBob();
    expect(gate.total).toBe(0);
  });

  it("records a refusal at the server cap, since a 503 is otherwise the only trace of it", () => {
    const logs = recordingLoggers();
    const gate = createConcurrencyGate({ perOwner: 10, global: 1, logger: logs.loggers.log });
    gate.acquire("alice");
    expect(() => gate.acquire("bob")).toThrow(/concurrent-run limit/);

    const record = logs.one("run.rejected");
    expect(record.level).toBe("warn");
    expect(record.fields).toMatchObject({
      reason: "concurrency_limit",
      scope: "server",
      in_flight: 1,
      limit: 1,
      owner: "bob",
    });
  });

  it("records a refusal at the owner cap under its own scope", () => {
    const logs = recordingLoggers();
    const gate = createConcurrencyGate({ perOwner: 1, global: 10, logger: logs.loggers.log });
    gate.acquire("alice");
    expect(() => gate.acquire("alice", 4)).toThrow(/this owner/);

    expect(logs.one("run.rejected").fields).toMatchObject({
      scope: "owner",
      in_flight: 1,
      limit: 1,
      owner: "alice",
    });
  });

  it("says nothing when a run is admitted", () => {
    const logs = recordingLoggers();
    const gate = createConcurrencyGate({ perOwner: 2, global: 2, logger: logs.loggers.log });
    gate.acquire("alice")();
    expect(logs.records).toHaveLength(0);
  });
});
