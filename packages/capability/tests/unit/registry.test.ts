import { describe, expect, it } from "../helpers/bun-test.ts";
import { z } from "zod";

import { composeCapabilityRegistry, createCapabilityRegistry } from "../../src/registry.ts";
import { requestParamKeys, type CapabilitySettingsSpec } from "../../src/settings-spec.ts";

function spec(key: string, over: Partial<CapabilitySettingsSpec> = {}): CapabilitySettingsSpec {
  return {
    key,
    schema: z.object({}),
    merge: "lastWins",
    pluginContributable: false,
    ...over,
  };
}

describe("createCapabilityRegistry", () => {
  it("starts empty", () => {
    expect(createCapabilityRegistry().specs()).toEqual([]);
    expect(createCapabilityRegistry().grants()).toEqual([]);
  });

  it("keeps registration order", () => {
    const registry = createCapabilityRegistry();
    registry.register(spec("workflows"));
    registry.register(spec("audit"));
    expect(registry.specs().map((s) => s.key)).toEqual(["workflows", "audit"]);
  });

  it("rejects a duplicate key rather than dropping the registration", () => {
    const registry = createCapabilityRegistry();
    registry.register(spec("workflows"));
    expect(() => registry.register(spec("workflows"))).toThrow(
      "capability settings key 'workflows' is already registered",
    );
  });

  it("returns a fresh array, so a caller cannot mutate the registry through it", () => {
    const registry = createCapabilityRegistry();
    registry.register(spec("workflows"));
    const first = registry.specs();
    (first as CapabilitySettingsSpec[]).push(spec("smuggled"));
    expect(registry.specs().map((s) => s.key)).toEqual(["workflows"]);
  });

  it("keeps capability grant declaration order and admits an identical repeat", () => {
    const registry = createCapabilityRegistry();
    registry.registerGrant({ name: "inspect" });
    registry.registerGrant({ name: "coordinate", entryCanSpawn: true });
    registry.registerGrant({ name: "inspect" });
    expect(registry.grants()).toEqual([
      { name: "inspect" },
      { name: "coordinate", entryCanSpawn: true },
    ]);
  });

  it("rejects empty or conflicting grant declarations", () => {
    const registry = createCapabilityRegistry();
    expect(() => registry.registerGrant({ name: "" })).toThrow("non-empty");
    registry.registerGrant({ name: "coordinate" });
    expect(() => registry.registerGrant({ name: "coordinate", entryCanSpawn: true })).toThrow(
      "already registered differently",
    );
  });

  it("composes an isolated per-run registry without mutating the base", () => {
    const base = createCapabilityRegistry();
    base.register(spec("audit"));
    base.registerGrant({ name: "inspect" });

    const composed = composeCapabilityRegistry(base, [
      { name: "inspect" },
      { name: "coordinate", entryCanSpawn: true },
    ]);

    expect(composed.specs().map((entry) => entry.key)).toEqual(["audit"]);
    expect(composed.grants()).toEqual([
      { name: "inspect" },
      { name: "coordinate", entryCanSpawn: true },
    ]);
    expect(base.grants()).toEqual([{ name: "inspect" }]);
  });
});

describe("requestParamKeys", () => {
  it("is empty when no spec declares request params", () => {
    expect(requestParamKeys([spec("a"), spec("b")])).toEqual([]);
  });

  it("collects every declared param key across specs", () => {
    const keys = requestParamKeys([
      spec("memory", { requestParams: { memory: z.string() } }),
      spec("plans", { requestParams: { plans: z.string(), plan_mode: z.string() } }),
      spec("workflows"),
    ]);
    expect(keys).toEqual(["memory", "plans", "plan_mode"]);
  });
});
