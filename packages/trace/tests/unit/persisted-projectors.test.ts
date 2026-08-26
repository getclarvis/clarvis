import { describe, expect, it } from "bun:test";
import { createPersistedTraceProjectorRegistry, type TraceEntry } from "@clarvis/capability";
import { mapEntry, mapTrace } from "../../src/trace-mapper.ts";

const ANCHOR = 1_700_000_000_000;
const ENTRY: TraceEntry = {
  at: 1.6,
  kind: "audit_event",
  detail: { action: "opened", api_key: "secret-value" },
};

describe("contributed persisted trace projectors", () => {
  it("uses a registered flat projection and sanitizes it", () => {
    const registry = createPersistedTraceProjectorRegistry([
      {
        kind: "audit_event",
        project(entry, context) {
          const detail = entry.detail as { action: string; api_key: string };
          return {
            type: entry.kind,
            occurred_at: context.absoluteTime(entry.at),
            action: detail.action,
            api_key: detail.api_key,
          };
        },
      },
    ]);
    expect(mapEntry(ENTRY, ANCHOR, registry)).toEqual({
      type: "audit_event",
      occurred_at: ANCHOR + 2,
      action: "opened",
      api_key: "[redacted]",
    });
  });

  it("preserves the current generic nested fallback when no projector matches", () => {
    expect(mapEntry(ENTRY, ANCHOR)).toEqual({
      type: "audit_event",
      occurred_at: ANCHOR + 2,
      detail: { action: "opened", api_key: "[redacted]" },
    });
  });

  it("shares the registry across every entry in mapTrace and honours an explicit drop", () => {
    const registry = createPersistedTraceProjectorRegistry([
      { kind: "audit_event", project: () => null },
    ]);
    expect(mapTrace([ENTRY, ENTRY], ANCHOR, registry)).toEqual({ events: [] });
  });
});
