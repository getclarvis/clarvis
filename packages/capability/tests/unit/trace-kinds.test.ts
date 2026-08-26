import { describe, expect, it } from "../helpers/bun-test.ts";

import {
  BUILTIN_TRACE_KINDS,
  isBuiltinTraceEntry,
  isBuiltinTraceKind,
  type BuiltinTraceEntry,
  type TraceEntry,
} from "../../src/trace.ts";

describe("BUILTIN_TRACE_KINDS", () => {
  it("has no duplicates", () => {
    expect(new Set(BUILTIN_TRACE_KINDS).size).toBe(BUILTIN_TRACE_KINDS.length);
  });

  it("recognises every kind it lists", () => {
    for (const kind of BUILTIN_TRACE_KINDS) expect(isBuiltinTraceKind(kind)).toBe(true);
  });
});

describe("isBuiltinTraceKind", () => {
  it("rejects a kind the engine does not declare", () => {
    expect(isBuiltinTraceKind("audit_finding_recorded")).toBe(false);
  });

  it("rejects a near-miss rather than matching loosely", () => {
    expect(isBuiltinTraceKind("tool_call ")).toBe(false);
    expect(isBuiltinTraceKind("TOOL_CALL")).toBe(false);
  });
});

describe("isBuiltinTraceEntry", () => {
  it("narrows a built-in entry so its detail stays exactly typed", () => {
    const entry: TraceEntry = {
      at: 5,
      kind: "lead_iteration_started",
      detail: { iteration: 1, started_at: 0, model: "m" },
    };
    expect(isBuiltinTraceEntry(entry)).toBe(true);
    if (!isBuiltinTraceEntry(entry)) throw new Error("unreachable");
    if (entry.kind === "lead_iteration_started") {
      expect(entry.detail.model).toBe("m");
    }
  });

  it("rejects an entry contributed by a capability the engine does not know", () => {
    const entry: TraceEntry = { at: 1, kind: "audit_finding_recorded", detail: { id: "f1" } };
    expect(isBuiltinTraceEntry(entry)).toBe(false);
  });

  it("keeps an exhaustive switch honest: narrow first, and the residual is never", () => {
    const seen: string[] = [];
    const project = (entry: TraceEntry): string | null => {
      if (!isBuiltinTraceEntry(entry)) return null;
      switch (entry.kind) {
        case "init":
          return "init";
        case "terminate":
          return "terminate";
        default: {
          seen.push(entry.kind);
          return entry.kind;
        }
      }
    };
    expect(project({ at: 0, kind: "init", detail: undefined })).toBe("init");
    expect(project({ at: 0, kind: "audit_finding_recorded", detail: {} })).toBeNull();
    expect(project({ at: 0, kind: "cancellation", detail: { reason: "x" } })).toBe("cancellation");
    expect(seen).toEqual(["cancellation"]);
  });
});

describe("the open arm", () => {
  it("admits a contributed entry without the engine declaring its kind", () => {
    const contributed: TraceEntry = {
      at: 12,
      kind: "audit_finding_recorded",
      detail: { severity: "high" },
    };
    expect(contributed.kind).toBe("audit_finding_recorded");
  });

  it("still assigns a built-in entry to the narrower type", () => {
    const builtin: BuiltinTraceEntry = { at: 0, kind: "init", detail: undefined };
    const widened: TraceEntry = builtin;
    expect(isBuiltinTraceEntry(widened)).toBe(true);
  });
});
