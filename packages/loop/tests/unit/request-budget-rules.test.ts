import { describe, expect, it } from "../bun-test.ts";
import { loadEnv, type RunRequest } from "@clarvis/capability";
import {
  enforceBudgetMode,
  enforceEnvCeilings,
} from "../../src/validation/request/budget-rules.ts";
import { requireEntryShape } from "../../src/validation/request/identity-rules.ts";
import { parsedRequest, validationCode, VALID_REQUEST } from "../helpers/request.ts";

function budgetCode(over: Parameters<typeof parsedRequest>[0]): string {
  const data = parsedRequest(over);
  return validationCode(() => enforceBudgetMode(data, requireEntryShape(data)));
}

describe("request budget rules", () => {
  it("accepts valid hard and soft modes", () => {
    expect(budgetCode({})).toBe("no_error");
    expect(
      budgetCode({
        budget: { on_exceed: "escalate", total_token_limit: 1_000 },
        profiles: [{ ...VALID_REQUEST.profiles[0]!, iteration_limit: undefined }],
      }),
    ).toBe("no_error");
  });

  const budgetModeFailures: Array<[string, Partial<RunRequest>, string]> = [
    ["hard mode token", { budget: { on_exceed: "stop" } }, "invalid_token_limit"],
    [
      "hard mode iteration",
      {
        budget: { on_exceed: "stop", total_token_limit: 1_000 },
        profiles: [{ ...VALID_REQUEST.profiles[0]!, iteration_limit: undefined }],
      },
      "invalid_iteration_limit",
    ],
    [
      "hard mode escalation count",
      { budget: { on_exceed: "stop", total_token_limit: 1_000, max_escalations: 1 } },
      "invalid_budget_mode",
    ],
    [
      "soft entry bound",
      {
        budget: { on_exceed: "escalate" },
        profiles: [{ ...VALID_REQUEST.profiles[0]!, iteration_limit: undefined }],
      },
      "invalid_budget_mode",
    ],
  ];

  it.each(budgetModeFailures)("requires %s", (_label, request, code) => {
    expect(budgetCode(request)).toBe(code);
  });

  it("requires a hard bound on every running lead profile", () => {
    const profiles = [
      { ...VALID_REQUEST.profiles[0]!, name: "lead", can_spawn: ["worker"] },
      { ...VALID_REQUEST.profiles[0]!, name: "worker", iteration_limit: undefined },
    ];
    expect(budgetCode({ entry: "lead", profiles })).toBe("invalid_iteration_limit");
  });

  const ceilingFailures: Array<[string, Partial<RunRequest>, string]> = [
    ["token", { budget: { on_exceed: "stop", total_token_limit: 1_001 } }, "invalid_token_limit"],
    [
      "iteration",
      { profiles: [{ ...VALID_REQUEST.profiles[0]!, iteration_limit: 11 }] },
      "invalid_iteration_limit",
    ],
    [
      "timeout",
      { budget: { on_exceed: "stop", total_token_limit: 1, timeout_ms: 11 } },
      "invalid_timeout",
    ],
    [
      "escalations",
      {
        budget: {
          on_exceed: "escalate",
          total_token_limit: 1,
          max_escalations: 11,
        },
      },
      "invalid_max_escalations",
    ],
  ];

  it.each(ceilingFailures)("enforces the %s environment ceiling", (_label, request, code) => {
    const env = loadEnv({
      CLARVIS_TOKEN_CEILING: "1000",
      CLARVIS_ITERATION_CEILING: "10",
      CLARVIS_TIMEOUT_CEILING_MS: "10",
      CLARVIS_ESCALATION_CEILING: "10",
      CLARVIS_DEFAULT_TOTAL_TOKEN_LIMIT: "1000",
      CLARVIS_DEFAULT_ITERATION_LIMIT: "10",
      CLARVIS_DEFAULT_TIMEOUT_MS: "10",
      CLARVIS_DEFAULT_CALL_TIMEOUT_MS: "10",
    });
    expect(validationCode(() => enforceEnvCeilings(parsedRequest(request), env))).toBe(code);
  });
});
