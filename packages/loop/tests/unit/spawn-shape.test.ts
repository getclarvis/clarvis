import { describe, expect, it } from "../bun-test.ts";
import type { CapabilityGrantDeclaration } from "@clarvis/capability";
import { canSpawnChildren } from "../../src/runtime/spawn-shape.ts";
import type { RunShape } from "../../src/runtime/run-shape.ts";

function shape(isLead: boolean, grants: readonly string[] = []): RunShape {
  return {
    isLead,
    entryProfile: { grants },
  } as unknown as RunShape;
}

const DECLARATIONS: readonly CapabilityGrantDeclaration[] = [
  { name: "coordinate", entryCanSpawn: true },
  { name: "inspect" },
];

describe("canSpawnChildren", () => {
  it("keeps a solo entry without supervision", () => {
    expect(canSpawnChildren(shape(false), DECLARATIONS)).toBe(false);
    expect(canSpawnChildren(shape(false, ["inspect"]), DECLARATIONS)).toBe(false);
  });

  it("always gives a lead supervision", () => {
    expect(canSpawnChildren(shape(true), [])).toBe(true);
  });

  it("derives manager supervision from an owning capability declaration", () => {
    expect(canSpawnChildren(shape(false, ["coordinate"]), DECLARATIONS)).toBe(true);
    expect(canSpawnChildren(shape(false, ["undeclared"]), DECLARATIONS)).toBe(false);
  });
});
