import { expect, test } from "bun:test";
import { buildGoalTools } from "../../src/tools.ts";

test("advertises mutually exclusive update actions inside one portable object envelope", () => {
  const schema = buildGoalTools()[1]!.inputSchema as {
    type: string;
    required: string[];
    properties: {
      update: { anyOf: Array<{ properties: Record<string, unknown>; required: string[] }> };
    };
  };
  expect(schema.type).toBe("object");
  expect(schema.required).toEqual(["update"]);
  const variants = schema.properties.update.anyOf;
  expect(variants.map((variant) => Object.keys(variant.properties).sort())).toEqual([
    ["action", "evidence_ids", "summary"],
    ["action", "evidence_ids", "next_step", "summary"],
    ["action", "assessments", "summary"],
    ["action", "reason"],
  ]);
  expect(variants.map((variant) => [...variant.required].sort())).toEqual([
    ["action", "summary"],
    ["action", "next_step", "summary"],
    ["action", "assessments", "summary"],
    ["action", "reason"],
  ]);
});
