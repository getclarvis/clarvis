import { describe, it, expect } from "../bun-test.ts";
import { collectCapabilityState } from "../../src/runtime/execute-run.ts";
import type { RunCapability } from "@clarvis/capability";

/** A capability that files `value` under `name`, or throws when told to. */
function cap(name: string, value: unknown, throws = false): RunCapability {
  return {
    name,
    forAgent: () => null,
    finalizeRun: () => {
      if (throws) throw new Error(`${name} exploded`);
      return value;
    },
  };
}

/**
 * The record's per-capability state slot. It replaced a typed `plan_ref` field,
 * so the engine no longer knows what any slot means — which makes *how it
 * handles a capability misbehaving* the whole contract.
 */
describe("collectCapabilityState", () => {
  it.each([
    ["completed", "checkpoint", false, true],
    ["error", "final", true, true],
    ["cancelled", "final", true, true],
    ["budget_exhausted", "final", true, true],
    ["completed", "final", true, false],
    ["cancelled", "final", false, false],
  ] as const)(
    "carries %s/%s and interruption policy %s to all finalizers",
    async (status, disposition, preserveStateOnInterruption, expected) => {
      const seen: unknown[] = [];
      await collectCapabilityState(
        [
          { name: "controller", forAgent: () => null, preserveStateOnInterruption },
          {
            name: "state",
            forAgent: () => null,
            finalizeRun: (outcome) => {
              seen.push(outcome);
            },
          },
        ],
        { status, disposition },
        undefined,
      );
      expect(seen).toEqual([{ status, disposition, preserveState: expected }]);
    },
  );
  it("files each capability's value under its own name", async () => {
    const state = await collectCapabilityState(
      [cap("plans", { id: "p1" }), cap("widgets", { ingested: 2 })],
      { status: "completed" },
      undefined,
    );
    expect(state).toEqual({ plans: { id: "p1" }, widgets: { ingested: 2 } });
  });

  it("omits a capability that returns undefined, rather than writing an empty slot", async () => {
    expect(
      await collectCapabilityState([cap("plans", undefined)], { status: "completed" }, undefined),
    ).toBeUndefined();
  });

  it("returns undefined when nothing contributed, so the record stays clean", async () => {
    const noHook: RunCapability = { name: "tools", forAgent: () => null };
    expect(
      await collectCapabilityState([noHook], { status: "completed" }, undefined),
    ).toBeUndefined();
  });

  it("hands each capability the run's terminal status", async () => {
    const seen: string[] = [];
    const spy: RunCapability = {
      name: "plans",
      forAgent: () => null,
      finalizeRun: ({ status }) => {
        seen.push(status);
        return status;
      },
    };
    await collectCapabilityState([spy], { status: "cancelled" }, undefined);
    expect(seen).toEqual(["cancelled"]);
  });

  it("forfeits only the throwing capability's slot — the run keeps its answer", async () => {
    const warned: string[] = [];
    const logger = {
      warn: (fields: Record<string, unknown>) => warned.push(String(fields.capability)),
    } as unknown as Parameters<typeof collectCapabilityState>[3];

    const state = await collectCapabilityState(
      [cap("plans", { id: "p1" }, true), cap("widgets", { ingested: 2 })],
      { status: "completed" },
      undefined,
      logger,
    );

    expect(state).toEqual({ widgets: { ingested: 2 } });
    expect(warned).toEqual(["plans"]);
  });

  it("forfeits only a capability whose finalizer never settles", async () => {
    const warnings: string[] = [];
    const stuck: RunCapability = {
      name: "stuck",
      forAgent: () => null,
      finalizeRun: () => new Promise<never>(() => undefined),
    };
    const logger = {
      warn: (_fields: Record<string, unknown>, message: string) => warnings.push(message),
    } as unknown as Parameters<typeof collectCapabilityState>[3];

    const state = await collectCapabilityState(
      [stuck, cap("widgets", { ingested: 2 })],
      { status: "completed" },
      undefined,
      logger,
      5,
    );

    expect(state).toEqual({ widgets: { ingested: 2 } });
    expect(warnings).toEqual([
      "finalizeRun exceeded its wall budget; the capability's state slot is omitted",
    ]);
  });

  it("carries a prior run's state forward for a capability that did not run this turn", async () => {
    // A continuation whose second turn has planning off must not silently drop
    // the first turn's plan reference from the record.
    const state = await collectCapabilityState(
      [cap("widgets", { ingested: 1 })],
      { status: "completed" },
      {
        plans: { id: "p1" },
      },
    );
    expect(state).toEqual({ plans: { id: "p1" }, widgets: { ingested: 1 } });
  });

  it("lets this turn's value replace the prior one for the same capability", async () => {
    const state = await collectCapabilityState(
      [cap("plans", { id: "p2" })],
      { status: "completed" },
      {
        plans: { id: "p1" },
      },
    );
    expect(state).toEqual({ plans: { id: "p2" } });
  });
});
