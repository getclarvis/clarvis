import { describe, expect, it } from "bun:test";
import { z } from "zod";
import {
  createCapabilityRegistry,
  isBuiltinTraceKind,
  type CapabilityEvent,
  type CapabilitySettingsSpec,
  type TraceEntry,
} from "@clarvis/capability";
import { mergeSettings, settingsSchemaFor } from "@clarvis/loop/host";

/**
 * Cross-package integration: a capability that lives outside `@clarvis/loop`
 * declares its own settings block, its own trace kind and its own wire
 * projection, and all three work without a single file in `packages/loop`
 * naming it.
 */

const auditConfigSchema = z
  .object({
    severity_floor: z.enum(["low", "medium", "high"]).default("low"),
    max_findings: z.number().int().positive().default(50),
  })
  .strict();

const auditSettingsSpec: CapabilitySettingsSpec = {
  key: "audit",
  schema: auditConfigSchema,
  merge: "lastWins",
  pluginContributable: false,
};

const AUDIT_TRACE_KIND = "audit_finding_recorded";

describe("a capability the engine has never heard of", () => {
  it("has its settings block accepted and validated by its own schema", () => {
    const registry = createCapabilityRegistry();
    registry.register(auditSettingsSpec);
    const schema = settingsSchemaFor(registry);

    const parsed = schema.parse({
      audit: { severity_floor: "high" },
    }) as unknown as Record<string, unknown>;

    expect(parsed.audit).toEqual({ severity_floor: "high", max_findings: 50 });
  });

  it("still has a typo in its own block rejected, rather than carried silently", () => {
    const registry = createCapabilityRegistry();
    registry.register(auditSettingsSpec);
    expect(() =>
      settingsSchemaFor(registry).parse({ audit: { severity_flooor: "high" } }),
    ).toThrow();
  });

  it("does not make the schema permissive: an unregistered key is still rejected", () => {
    const registry = createCapabilityRegistry();
    registry.register(auditSettingsSpec);
    expect(() => settingsSchemaFor(registry).parse({ nonsense: true })).toThrow();
  });

  it("is invisible to a schema built without registering it", () => {
    expect(() => settingsSchemaFor().parse({ audit: { severity_floor: "high" } })).toThrow();
  });

  it("merges its block across scopes with the strategy it declared", () => {
    const registry = createCapabilityRegistry();
    registry.register(auditSettingsSpec);
    const merged = mergeSettings(
      [
        { origin: "operator", settings: { audit: { severity_floor: "low" } } },
        { origin: "operator", settings: { audit: { severity_floor: "high" } } },
      ] as never,
      registry,
    ) as unknown as Record<string, unknown>;
    expect(merged.audit).toEqual({ severity_floor: "high" });
  });

  it("records a trace kind the engine does not declare", () => {
    expect(isBuiltinTraceKind(AUDIT_TRACE_KIND)).toBe(false);
    const entry: TraceEntry = {
      at: 4,
      kind: AUDIT_TRACE_KIND,
      detail: { id: "f1", severity: "high" },
    };
    expect(entry.kind).toBe(AUDIT_TRACE_KIND);
  });

  it("declares the wire projection a host needs to relay it to a client", () => {
    const event: CapabilityEvent = {
      capability: "audit",
      kind: AUDIT_TRACE_KIND,
      detail: { id: "f1" },
      wire: { type: AUDIT_TRACE_KIND, detail: { id: "f1", severity: "high" } },
    };
    expect(event.wire).toEqual({
      type: AUDIT_TRACE_KIND,
      detail: { id: "f1", severity: "high" },
    });
  });
});
