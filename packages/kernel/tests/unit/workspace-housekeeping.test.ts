import { describe, expect, it, vi } from "bun:test";
import { WorkspaceHousekeeping } from "../../src/application/workspace-housekeeping.ts";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("WorkspaceHousekeeping", () => {
  it("coalesces concurrent passes instead of stacking collectors", async () => {
    const spills = deferred();
    let spillCalls = 0;
    let globalCalls = 0;
    const housekeeping = new WorkspaceHousekeeping({
      sweepSpills: () => {
        spillCalls += 1;
        return spills.promise;
      },
      sweepGlobalArtifacts: async () => void (globalCalls += 1),
    });

    const first = housekeeping.runOnce();
    const second = housekeeping.runOnce();
    expect(second).toBe(first);
    expect(spillCalls).toBe(1);
    expect(globalCalls).toBe(1);

    spills.resolve();
    await first;
    await housekeeping.runOnce();
    expect(spillCalls).toBe(2);
    expect(globalCalls).toBe(2);
  });

  it("starts immediately on one timer and stops idempotently", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const housekeeping = new WorkspaceHousekeeping({
        sweepSpills: async () => void (calls += 1),
      });

      housekeeping.start(1_000);
      housekeeping.start(1_000);
      await housekeeping.runOnce();
      expect(calls).toBe(1);

      await housekeeping.stop();
      await housekeeping.stop();
      vi.advanceTimersByTime(2_000);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("isolates collector failures", async () => {
    let globalArtifacts = 0;
    const warnings: unknown[] = [];
    const housekeeping = new WorkspaceHousekeeping({
      sweepSpills: () => Promise.reject(new Error("disk unavailable")),
      sweepGlobalArtifacts: async () => void (globalArtifacts += 1),
      logger: {
        warn: (details: unknown) => void warnings.push(details),
      } as never,
    });

    await expect(housekeeping.runOnce()).resolves.toBeUndefined();
    expect(globalArtifacts).toBe(1);
    expect(warnings).toHaveLength(1);
  });
});
