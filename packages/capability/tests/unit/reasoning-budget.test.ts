import { describe, it, expect } from "../helpers/bun-test.ts";
import { reasoningOutputFloor } from "../../src/reasoning-budget.ts";

const ANSWER_HEADROOM = 8192;

describe("reasoningOutputFloor", () => {
  it("returns no floor for a non-anthropic provider kind", () => {
    expect(reasoningOutputFloor("openai", "high")).toBeUndefined();
    expect(reasoningOutputFloor("google", "max")).toBeUndefined();
    expect(reasoningOutputFloor("openai-compatible", "low")).toBeUndefined();
  });

  it("returns no floor when the kind is unknown", () => {
    expect(reasoningOutputFloor(undefined, "high")).toBeUndefined();
  });

  it("returns no floor when no effort is requested or effort is off", () => {
    expect(reasoningOutputFloor("anthropic", undefined)).toBeUndefined();
    expect(reasoningOutputFloor("anthropic", "off")).toBeUndefined();
  });

  it("adds the answer headroom to each effort's thinking headroom", () => {
    expect(reasoningOutputFloor("anthropic", "minimal")).toBe(1024 + ANSWER_HEADROOM);
    expect(reasoningOutputFloor("anthropic", "low")).toBe(2048 + ANSWER_HEADROOM);
    expect(reasoningOutputFloor("anthropic", "medium")).toBe(4096 + ANSWER_HEADROOM);
    expect(reasoningOutputFloor("anthropic", "high")).toBe(8192 + ANSWER_HEADROOM);
    expect(reasoningOutputFloor("anthropic", "xhigh")).toBe(16384 + ANSWER_HEADROOM);
    expect(reasoningOutputFloor("anthropic", "max")).toBe(32768 + ANSWER_HEADROOM);
  });

  it("is monotonic in effort, so a deeper effort never reserves less", () => {
    const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
    const floors = efforts.map((e) => reasoningOutputFloor("anthropic", e) ?? 0);
    expect(floors).toEqual([...floors].sort((a, b) => a - b));
  });
});
