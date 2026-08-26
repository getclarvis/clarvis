import { describe, expect, it } from "../bun-test.ts";
import {
  createExtensionAdmissionController,
  ExtensionCallUnavailableError,
  type LifecycleHook,
  type RunCapability,
} from "@clarvis/capability";
import {
  admittedRunCapability,
  capabilityActivationOperation,
  isExtensionAdmissionRefusal,
} from "../../src/runtime/extension-admission.ts";

describe("admittedRunCapability", () => {
  it("routes every asynchronous extension surface through the physical gate", async () => {
    const calls: string[] = [];
    const hook: LifecycleHook = {
      beforeToolUse: async () => {
        calls.push("beforeToolUse");
        return { kind: "pass" };
      },
      afterToolUse: async () => {
        calls.push("afterToolUse");
        return { kind: "pass" };
      },
      preFinalize: async () => {
        calls.push("preFinalize");
        return { kind: "pass" };
      },
      preDelegateTask: async () => {
        calls.push("preDelegateTask");
        return { kind: "pass" };
      },
      onRunStart: async () => void calls.push("onRunStart"),
      onRunEnd: async () => void calls.push("lifecycle:onRunEnd"),
      onSubagentComplete: async () => void calls.push("onSubagentComplete"),
      onPreCompact: async () => {
        calls.push("onPreCompact");
        return [{ source: "test", text: "keep" }];
      },
      onModelCallError: async () => void calls.push("onModelCallError"),
      onBudgetExhausted: async () => void calls.push("onBudgetExhausted"),
      onUserSteer: async () => void calls.push("onUserSteer"),
    };
    const activated: RunCapability = {
      name: "wrapped",
      order: 7,
      seedBlock: () => {
        calls.push("seedBlock");
        return "seed";
      },
      systemSection: () => {
        calls.push("systemSection");
        return "section";
      },
      lifecycle: [hook],
      forAgent: () => {
        calls.push("forAgent");
        return null;
      },
      finalizeRun: () => {
        calls.push("finalizeRun");
        return { state: true };
      },
      onRunEnd: async () => void calls.push("capability:onRunEnd"),
      guardTripCodes: ["guarded"],
    };
    const admission = createExtensionAdmissionController();
    const wrapped = admittedRunCapability("wrapped", activated, admission);
    const lifecycle = wrapped.lifecycle![0]!;

    expect(await wrapped.seedBlock!()).toBe("seed");
    expect(wrapped.systemSection!({ agent: "lead", entry: true, grants: [] })).toBe("section");
    expect(wrapped.forAgent({ agent: "lead", entry: true, grants: [] })).toBeNull();
    await lifecycle.beforeToolUse!({ tool: "read", arguments: {} });
    await lifecycle.afterToolUse!({
      tool: "read",
      arguments: {},
      result: { text: "ok", progress: true },
    });
    await lifecycle.preFinalize!({ agent: "lead", mode: "text", text: "done" });
    await lifecycle.preDelegateTask!({ title: "child", task: "work", profile: "coder" });
    await lifecycle.onRunStart!({ mode: "solo", entry: "lead" });
    await lifecycle.onRunEnd!({ status: "completed", iterationsUsed: 1, elapsedMs: 2 });
    await lifecycle.onSubagentComplete!({
      subagentInstanceId: "child-1",
      status: "completed",
      result: "done",
    });
    expect(await lifecycle.onPreCompact!({ agent: "lead", estimatedTokens: 10 })).toEqual([
      { source: "test", text: "keep" },
    ]);
    await lifecycle.onModelCallError!({
      agent: "lead",
      iteration: 1,
      model: "provider/model",
      message: "down",
    });
    await lifecycle.onBudgetExhausted!({
      agent: "lead",
      reason: "exhausted",
      tokensUsed: 10,
      iterationsUsed: 1,
    });
    await lifecycle.onUserSteer!({ agent: "lead", iteration: 1, message: "continue" });
    expect(await wrapped.finalizeRun!({ status: "completed" })).toEqual({ state: true });
    await wrapped.onRunEnd!({} as Parameters<NonNullable<RunCapability["onRunEnd"]>>[0]);

    expect(wrapped.order).toBe(7);
    expect(wrapped.guardTripCodes).toEqual(["guarded"]);
    expect(calls).toEqual([
      "seedBlock",
      "systemSection",
      "forAgent",
      "beforeToolUse",
      "afterToolUse",
      "preFinalize",
      "preDelegateTask",
      "onRunStart",
      "lifecycle:onRunEnd",
      "onSubagentComplete",
      "onPreCompact",
      "onModelCallError",
      "onBudgetExhausted",
      "onUserSteer",
      "finalizeRun",
      "capability:onRunEnd",
    ]);
    expect(admission.snapshot().active).toBe(0);
  });

  it("omits a saturated seed before invocation and rethrows ordinary failures", async () => {
    const admission = createExtensionAdmissionController({
      maxActiveNormal: 2,
      maxActiveRunEnd: 1,
      maxActivePerOperation: 1,
    });
    void admission.call(
      "capability:wrapped:seedBlock",
      "normal",
      () => new Promise<never>(() => undefined),
    );
    const warnings: string[] = [];
    let starts = 0;
    const saturated = admittedRunCapability(
      "wrapped",
      {
        name: "wrapped",
        seedBlock: () => {
          starts += 1;
          return "late";
        },
        forAgent: () => null,
      },
      admission,
      {
        debug: () => undefined,
        info: () => undefined,
        warn: (...args: unknown[]) => {
          const message = args[1];
          if (typeof message === "string") warnings.push(message);
        },
        error: () => undefined,
      },
    );

    expect(await saturated.seedBlock!()).toBeUndefined();
    expect(starts).toBe(0);
    expect(warnings).toEqual([
      "the host's extension gate is saturated; seedBlock is omitted before invocation",
    ]);

    const throws = admittedRunCapability(
      "throws",
      {
        name: "throws",
        seedBlock: () => {
          throw new Error("boom");
        },
        forAgent: () => null,
      },
      admission,
    );
    await expect(throws.seedBlock!()).rejects.toThrow("boom");
  });

  it("exposes stable activation keys and the typed refusal guard", () => {
    const refusal = new ExtensionCallUnavailableError("capability:x:forRun", "capacity_full");
    expect(capabilityActivationOperation("x")).toBe("capability:x:forRun");
    expect(isExtensionAdmissionRefusal(refusal)).toBe(true);
    expect(isExtensionAdmissionRefusal(new Error("other"))).toBe(false);
  });
});
