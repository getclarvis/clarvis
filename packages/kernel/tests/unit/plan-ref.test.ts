import { describe, it, expect } from "bun:test";
import type { PlanRef } from "@clarvis/protocol";
import { planRefFromCapabilityState } from "../../src/runs/plan-ref.ts";

const validRef: PlanRef = {
  id: "p1",
  provider_key: "markdown",
  path: ".clarvis/plans/p.md",
  final_revision: 3,
  final_spec_revision: 2,
  status: "completed",
  retention: "keep",
};

describe("planRefFromCapabilityState", () => {
  it("returns the plans slot unchanged when it satisfies PlanRef", () => {
    expect(planRefFromCapabilityState({ plans: validRef })).toEqual(validRef);
  });

  it("accepts a ref with no path (the one optional field)", () => {
    const { path: _path, ...withoutPath } = validRef;
    expect(planRefFromCapabilityState({ plans: withoutPath })).toEqual(withoutPath);
  });

  it("returns undefined when capability_state is absent", () => {
    expect(planRefFromCapabilityState(undefined)).toBeUndefined();
  });

  it("returns undefined when capability_state carries no plans slot", () => {
    expect(planRefFromCapabilityState({ memory: { some: "thing" } })).toBeUndefined();
  });

  it("returns undefined when the slot is not an object", () => {
    expect(planRefFromCapabilityState({ plans: "p1" })).toBeUndefined();
    expect(planRefFromCapabilityState({ plans: 42 })).toBeUndefined();
    expect(planRefFromCapabilityState({ plans: null })).toBeUndefined();
    expect(planRefFromCapabilityState({ plans: ["p1"] })).toBeUndefined();
  });

  it("returns undefined when a required field is missing", () => {
    const { id: _id, ...withoutId } = validRef;
    expect(planRefFromCapabilityState({ plans: withoutId })).toBeUndefined();
    const { final_revision: _fr, ...withoutFinalRevision } = validRef;
    expect(planRefFromCapabilityState({ plans: withoutFinalRevision })).toBeUndefined();
    const { provider_key: _providerKey, ...withoutProviderKey } = validRef;
    expect(planRefFromCapabilityState({ plans: withoutProviderKey })).toBeUndefined();
  });

  it("returns undefined when a field carries the wrong primitive type", () => {
    expect(planRefFromCapabilityState({ plans: { ...validRef, id: 1 } })).toBeUndefined();
    expect(
      planRefFromCapabilityState({ plans: { ...validRef, final_revision: "3" } }),
    ).toBeUndefined();
    expect(planRefFromCapabilityState({ plans: { ...validRef, path: 7 } })).toBeUndefined();
  });

  it("returns undefined when status or retention is outside its literal set", () => {
    expect(
      planRefFromCapabilityState({ plans: { ...validRef, status: "archived" } }),
    ).toBeUndefined();
    expect(
      planRefFromCapabilityState({ plans: { ...validRef, retention: "delete" } }),
    ).toBeUndefined();
  });
});
