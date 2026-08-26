import { describe, expect, it } from "../helpers/bun-test.ts";
import {
  ExtensionCallUnavailableError,
  createExtensionAdmissionController,
} from "../../src/extension-admission.ts";
import type { Logger } from "../../src/ports.ts";

interface Recorded {
  level: string;
  fields: Record<string, unknown>;
}

function recordingLogger(): { logger: Logger; records: Recorded[] } {
  const records: Recorded[] = [];
  const at =
    (level: string) =>
    (obj: unknown): void => {
      records.push({ level, fields: obj as Record<string, unknown> });
    };
  return {
    records,
    logger: { debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") },
  };
}

describe("ExtensionAdmissionController", () => {
  it("retains a physical permit until the real promise settles", async () => {
    let settle!: () => void;
    const physical = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const admission = createExtensionAdmissionController({
      maxActiveNormal: 2,
      maxActiveRunEnd: 1,
      maxActivePerOperation: 1,
    });

    const first = admission.call("memory:forRun", "normal", () => physical);
    expect(admission.snapshot()).toMatchObject({ active: 1, activeNormal: 1 });
    expect(() => admission.call("memory:forRun", "normal", () => undefined)).toThrow(
      ExtensionCallUnavailableError,
    );
    expect(admission.snapshot().activeNormal).toBe(1);

    settle();
    await first;
    await Promise.resolve();
    expect(admission.snapshot().active).toBe(0);
    await expect(admission.call("memory:forRun", "normal", () => "ready")).resolves.toBe("ready");
  });

  it("bounds iterative never-settling calls while healthy sibling operations continue", async () => {
    const admission = createExtensionAdmissionController({
      maxActiveNormal: 8,
      maxActiveRunEnd: 2,
      maxActivePerOperation: 2,
    });
    let stuckStarted = 0;
    let healthyCompleted = 0;

    for (let index = 0; index < 100; index += 1) {
      try {
        void admission.call("broken:onUserSteer", "normal", () => {
          stuckStarted += 1;
          return new Promise<never>(() => undefined);
        });
      } catch (error) {
        expect(error).toBeInstanceOf(ExtensionCallUnavailableError);
      }
      await admission.call("healthy:onUserSteer", "normal", () => {
        healthyCompleted += 1;
      });
    }

    expect(stuckStarted).toBe(2);
    expect(healthyCompleted).toBe(100);
    expect(admission.snapshot()).toMatchObject({ active: 2, activeNormal: 2 });
  });

  it("keeps run-end capacity independent from saturated ordinary work", async () => {
    const admission = createExtensionAdmissionController({
      maxActiveNormal: 1,
      maxActiveRunEnd: 2,
      maxActivePerOperation: 2,
    });
    void admission.call("broken:seedBlock", "normal", () => new Promise<never>(() => undefined));

    let finalized = false;
    await admission.call("healthy:onRunEnd", "run_end", () => {
      finalized = true;
    });

    expect(finalized).toBe(true);
    expect(admission.snapshot()).toMatchObject({ activeNormal: 1, activeRunEnd: 0 });
  });

  it("rejects class saturation, close, and invalid constructor values", async () => {
    const admission = createExtensionAdmissionController({
      maxActiveNormal: 1,
      maxActiveRunEnd: 1,
      maxActivePerOperation: 2,
    });
    void admission.call("a", "normal", () => new Promise<never>(() => undefined));
    expect(() => admission.call("b", "normal", () => undefined)).toThrow(
      expect.objectContaining({ reason: "capacity_full" }),
    );
    admission.close();
    expect(() => admission.call("end", "run_end", () => undefined)).toThrow(
      expect.objectContaining({ reason: "closed" }),
    );
    expect(() => createExtensionAdmissionController({ maxActiveNormal: 0 })).toThrow(TypeError);
    expect(() => createExtensionAdmissionController({ maxActiveRunEnd: 1.5 })).toThrow(TypeError);
    expect(() => createExtensionAdmissionController({ maxActivePerOperation: -1 })).toThrow(
      TypeError,
    );
    expect(() => createExtensionAdmissionController().call("", "normal", () => undefined)).toThrow(
      TypeError,
    );
  });

  it("swallows a throwing diagnostics sink without leaking a permit", async () => {
    const admission = createExtensionAdmissionController({
      onStateChange: () => {
        throw new Error("metrics down");
      },
    });
    await admission.call("healthy", "normal", () => undefined);
    await Promise.resolve();
    expect(admission.snapshot().active).toBe(0);
  });

  it("reports a refusal with the occupancy that caused it, not just its class", () => {
    const sink = recordingLogger();
    const admission = createExtensionAdmissionController({
      maxActivePerOperation: 1,
      logger: sink.logger,
    });
    void admission.call("stuck", "normal", () => new Promise<void>(() => {}));
    expect(() => admission.call("stuck", "normal", () => undefined)).toThrow(
      ExtensionCallUnavailableError,
    );
    expect(sink.records).toEqual([
      {
        level: "debug",
        fields: {
          event: "capability.extension_permit_refused",
          operation: "stuck",
          call_class: "normal",
          reason: "operation_busy",
          active_normal: 1,
          active_run_end: 0,
          max_active_per_operation: 1,
        },
      },
    ]);
  });

  it("reports a refusal from a closed controller too", () => {
    const sink = recordingLogger();
    const admission = createExtensionAdmissionController({ logger: sink.logger });
    admission.close();
    expect(() => admission.call("late", "run_end", () => undefined)).toThrow(
      ExtensionCallUnavailableError,
    );
    expect(sink.records[0]?.fields).toMatchObject({
      event: "capability.extension_permit_refused",
      call_class: "run_end",
      reason: "closed",
    });
  });

  it("reports a throwing observer instead of discarding it in silence", async () => {
    const sink = recordingLogger();
    const admission = createExtensionAdmissionController({
      logger: sink.logger,
      onStateChange: () => {
        throw new Error("metrics down");
      },
    });
    await admission.call("healthy", "normal", () => undefined);
    await Promise.resolve();
    expect(sink.records[0]).toEqual({
      level: "debug",
      fields: { event: "capability.admission_observer_failed", err: "metrics down" },
    });
  });

  it("discards refusals when no host supplied a logger", () => {
    const admission = createExtensionAdmissionController({ maxActivePerOperation: 1 });
    void admission.call("stuck", "normal", () => new Promise<void>(() => {}));
    expect(() => admission.call("stuck", "normal", () => undefined)).toThrow(
      ExtensionCallUnavailableError,
    );
  });
});
