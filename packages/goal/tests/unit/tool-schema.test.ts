import { expect, test } from "bun:test";
import { buildGoalTools } from "#src/tools.ts";

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

test("discards extra Goal tool fields without accepting invalid known values", async () => {
  const { goalCreationInputSchema, goalModelToolInputSchema } = await import("#src/model-input.ts");
  const { getGoalInputSchema } = await import("#src/tools.ts");
  expect(getGoalInputSchema.parse({ goal_id: "foreign" })).toEqual({});
  const created = goalCreationInputSchema.parse({
    objective: "Deliver",
    goal_id: "foreign",
    max_net_tokens: 999,
    criteria: [
      {
        id: "c1",
        description: "Verified",
        kind: "host",
        extra: true,
        verification: { kind: "tool_success", tool_name: "read_file", extra: true },
      },
    ],
  });
  expect(created).not.toHaveProperty("goal_id");
  expect(created).not.toHaveProperty("max_net_tokens");
  expect(created.criteria[0]).not.toHaveProperty("extra");
  expect(created.criteria[0]!.verification).not.toHaveProperty("extra");
  const update = goalModelToolInputSchema.parse({
    goal_id: "foreign",
    update: {
      action: "candidate",
      summary: "Delivered",
      extra: true,
      assessments: [{ criterion_id: "c1", kind: "host", justification: "Observed", extra: true }],
    },
  });
  expect(update).toEqual({
    update: {
      action: "candidate",
      summary: "Delivered",
      assessments: [
        { criterion_id: "c1", kind: "host", justification: "Observed", evidence_ids: [] },
      ],
    },
  });
  expect(
    goalModelToolInputSchema.safeParse({ update: { action: "resume", extra: true } }).success,
  ).toBe(false);
  expect(goalCreationInputSchema.safeParse({ objective: 42, extra: true }).success).toBe(false);
});
