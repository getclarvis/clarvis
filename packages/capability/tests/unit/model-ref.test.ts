import { describe, it, expect } from "../helpers/bun-test.ts";
import { parseModelRef } from "../../src/model-ref.ts";

describe("parseModelRef without a slash", () => {
  it("returns the whole token as provider with an empty modelId", () => {
    expect(parseModelRef("anthropic")).toEqual({ provider: "anthropic", modelId: "" });
  });

  it("splits on the first slash when present", () => {
    expect(parseModelRef("deepinfra/deepseek-ai/x")).toEqual({
      provider: "deepinfra",
      modelId: "deepseek-ai/x",
    });
  });
});
