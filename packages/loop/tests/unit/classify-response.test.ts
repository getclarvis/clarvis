import { describe, it, expect } from "../bun-test.ts";
import { classifyResponse } from "../../src/runtime/loop/classify-response.ts";

const usage = { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cache_write_tokens: 0 };

describe("classifyResponse", () => {
  it("tool calls win over text and reasoning", () => {
    expect(
      classifyResponse({
        text: "t",
        reasoning: "r",
        toolCalls: [{ id: "c1", name: "x", arguments: {} }],
        usage,
      }),
    ).toBe("has-tools");
  });

  it("text without tool calls is text-only, even alongside reasoning", () => {
    expect(classifyResponse({ text: "t", reasoning: "r", usage })).toBe("text-only");
  });

  it("reasoning alone is reasoning-only, not empty", () => {
    expect(classifyResponse({ reasoning: "thinking...", usage })).toBe("reasoning-only");
  });

  it("no text, no tool calls, no reasoning is empty (empty strings included)", () => {
    expect(classifyResponse({ usage })).toBe("empty");
    expect(classifyResponse({ text: "", reasoning: "", toolCalls: [], usage })).toBe("empty");
  });
});
