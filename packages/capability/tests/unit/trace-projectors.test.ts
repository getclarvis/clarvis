import { describe, expect, it } from "../helpers/bun-test.ts";
import {
  composePersistedTraceProjectors,
  createPersistedTraceProjectorRegistry,
  type PersistedTraceProjector,
} from "../../src/trace-projectors.ts";

const projector = (kind: string): PersistedTraceProjector => ({
  kind,
  project: (entry, context) => ({
    type: kind,
    occurred_at: context.absoluteTime(entry.at),
  }),
});

describe("persisted trace projector registry", () => {
  it("is an immutable lookup snapshot in declaration order", () => {
    const first = projector("audit.started");
    const second = projector("audit.finished");
    const registry = createPersistedTraceProjectorRegistry([first, second]);
    expect(registry.projectorFor("audit.started")).toBe(first);
    expect(registry.projectors()).toEqual([first, second]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.projectors())).toBe(true);
  });

  it("rejects empty and duplicate kinds instead of making order choose a winner", () => {
    expect(() => createPersistedTraceProjectorRegistry([projector("")])).toThrow("non-empty");
    expect(() =>
      createPersistedTraceProjectorRegistry([projector("audit"), projector("audit")]),
    ).toThrow("already registered");
  });

  it("rejects projectors for engine-owned trace kinds", () => {
    expect(() => createPersistedTraceProjectorRegistry([projector("run_started")])).toThrow(
      "cannot replace an engine-owned trace kind",
    );
  });

  it("composes a fresh run snapshot without mutating its host registry", () => {
    const host = createPersistedTraceProjectorRegistry([projector("host")]);
    const run = composePersistedTraceProjectors(host, [projector("run")]);
    expect(host.projectors().map((entry) => entry.kind)).toEqual(["host"]);
    expect(run.projectors().map((entry) => entry.kind)).toEqual(["host", "run"]);
  });
});
