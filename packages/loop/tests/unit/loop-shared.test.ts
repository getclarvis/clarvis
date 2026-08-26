import { describe, it, expect } from "../bun-test.ts";
import { toLlmTarget } from "../../src/runtime/loop/loop-shared.ts";
import type { LLMProvider } from "@clarvis/capability";

const fakeLlm = {} as unknown as LLMProvider;

describe("toLlmTarget", () => {
  it("copies reasoningEffort onto the target when set, omitting it otherwise", () => {
    const withEffort = toLlmTarget(fakeLlm, {
      model: "m",
      provider: "p",
      reasoningEffort: "high",
    });
    expect(withEffort.reasoningEffort).toBe("high");

    const withoutEffort = toLlmTarget(fakeLlm, { model: "m", provider: "p" });
    expect("reasoningEffort" in withoutEffort).toBe(false);
  });
});
