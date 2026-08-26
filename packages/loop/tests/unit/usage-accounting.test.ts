import { describe, expect, it } from "../bun-test.ts";
import { createUsageAccounting } from "../../src/runtime/usage-accounting.ts";
import type { RunShape } from "../../src/runtime/run-shape.ts";
import type { EnvConfig } from "@clarvis/capability";

function fakeShape(over: Partial<RunShape> = {}): RunShape {
  return {
    entryProfile: { model: "test-model" },
    entryResolved: { model: "test-model" },
    isLead: false,
    userInputEnabled: false,
    askUserGranted: false,
    softMode: false,
    spawnableRegistry: new Map(),
    fullRegistry: new Map(),
    primarySubagentModel: "test-model",
    ...over,
  } as RunShape;
}

describe("createUsageAccounting — finalize warnings", () => {
  it("attaches warnings accumulated after construction to a non-lead run's usage", () => {
    const accounting = createUsageAccounting({
      shape: fakeShape({ isLead: false }),
      deps: { env: {} as EnvConfig },
      entryMax: 10,
      startedAt: performance.now(),
    });
    accounting.warnings.push("2 child agent(s) abandoned when the run finished: ag_a, ag_b");
    const usage = accounting.finalize();
    expect(usage.warnings).toEqual([
      "2 child agent(s) abandoned when the run finished: ag_a, ag_b",
    ]);
  });

  it("omits warnings entirely from a non-lead run's usage when there are none", () => {
    const accounting = createUsageAccounting({
      shape: fakeShape({ isLead: false }),
      deps: { env: {} as EnvConfig },
      entryMax: 10,
      startedAt: performance.now(),
    });
    const usage = accounting.finalize();
    expect(usage.warnings).toBeUndefined();
  });

  it("also attaches warnings accumulated after construction to a lead run's usage", () => {
    const accounting = createUsageAccounting({
      shape: fakeShape({ isLead: true }),
      deps: { env: {} as EnvConfig },
      entryMax: 10,
      startedAt: performance.now(),
    });
    accounting.warnings.push("late warning");
    const usage = accounting.finalize();
    expect(usage.warnings).toContain("late warning");
  });
});
