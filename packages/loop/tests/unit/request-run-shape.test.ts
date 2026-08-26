import { describe, expect, it } from "../bun-test.ts";
import { deriveRunShape } from "../../src/validation/request/run-shape.ts";
import { VALID_REQUEST } from "../helpers/request.ts";

describe("deriveRunShape", () => {
  it("returns undefined for an unresolved entry", () => {
    expect(deriveRunShape({ ...VALID_REQUEST, entry: "missing" })).toBeUndefined();
  });

  it.each([
    ["plain", {}, false, false, false],
    ["lead", { can_spawn: ["worker"] }, true, false, false],
    ["ask user", { grants: ["ask_user"] }, false, true, true],
  ])("derives the %s shape", (_label, profile, isLead, userInputEnabled, humanParkLikely) => {
    const request = {
      ...VALID_REQUEST,
      profiles: [{ ...VALID_REQUEST.profiles[0]!, ...profile }],
    };
    expect(deriveRunShape(request)).toMatchObject({ isLead, userInputEnabled, humanParkLikely });
  });

  it("distinguishes soft budget, capability human input, and an explicit zero wait", () => {
    expect(
      deriveRunShape({
        ...VALID_REQUEST,
        budget: { on_exceed: "escalate", total_token_limit: 1 },
      }),
    ).toMatchObject({ softMode: true, userInputEnabled: true, humanParkLikely: false });
    expect(deriveRunShape(VALID_REQUEST, true)).toMatchObject({
      userInputEnabled: true,
      humanParkLikely: true,
    });
    expect(
      deriveRunShape(
        {
          ...VALID_REQUEST,
          elicit_wait_ms: 0,
          profiles: [{ ...VALID_REQUEST.profiles[0]!, grants: ["ask_user"] }],
        },
        true,
      ),
    ).toMatchObject({ askUserGranted: true, userInputEnabled: true, humanParkLikely: false });
  });
});
