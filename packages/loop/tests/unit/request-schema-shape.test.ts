import { describe, expect, test } from "bun:test";
import { budgetSchema, runRequestSchema } from "../../src/validation/request/request-schema.ts";
import { VALID_REQUEST } from "../helpers/request.ts";

describe("run request schema", () => {
  test("accepts the canonical request and supported cache controls", () => {
    expect(runRequestSchema.safeParse(VALID_REQUEST).success).toBe(true);
    expect(
      runRequestSchema.safeParse({
        ...VALID_REQUEST,
        execution_id: "run:one",
        continue_from: "run:zero",
        prompt_cache_key: "conversation-one",
        prompt_cache_ttl: "1h",
        output_schema: { type: "object" },
      }).success,
    ).toBe(true);
  });

  test("is strict at the request and budget boundaries", () => {
    expect(runRequestSchema.safeParse({ ...VALID_REQUEST, unexpected: true }).success).toBe(false);
    expect(
      runRequestSchema.safeParse({
        ...VALID_REQUEST,
        budget: { ...VALID_REQUEST.budget, unexpected: true },
      }).success,
    ).toBe(false);
  });

  test.each([
    { on_exceed: "stop", total_token_limit: 1 },
    { on_exceed: "escalate", timeout_ms: 1, max_escalations: 1 },
  ])("accepts structurally valid budget variants", (budget) => {
    expect(budgetSchema.safeParse(budget).success).toBe(true);
  });
});
