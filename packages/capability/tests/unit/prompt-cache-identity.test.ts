import { describe, expect, it } from "bun:test";
import { composePromptCacheKey } from "../../src/prompt-cache-identity.ts";

describe("persisted prompt-cache identity", () => {
  it("is stable within an instance and distinct across sessions and instances", () => {
    const identities = [
      { sessionId: "session-1", agentInstanceId: "leader-1" },
      { sessionId: "session-1", agentInstanceId: "explorer-1" },
      { sessionId: "session-1", agentInstanceId: "explorer-2" },
      { sessionId: "session-1", agentInstanceId: "memory-1" },
      { sessionId: "session-2", agentInstanceId: "leader-1" },
    ];
    expect(new Set(identities.map(composePromptCacheKey)).size).toBe(identities.length);
    for (const identity of identities)
      expect(composePromptCacheKey(JSON.parse(JSON.stringify(identity)))).toBe(
        composePromptCacheKey(identity),
      );
    expect(composePromptCacheKey(identities[0]!)).toBe("session-1_leader-1");
  });

  it("escapes embedded separators without ambiguous compositions", () => {
    expect(composePromptCacheKey({ sessionId: "a_b", agentInstanceId: "c" })).toBe("a%5Fb_c");
    expect(composePromptCacheKey({ sessionId: "a", agentInstanceId: "b_c" })).toBe("a_b%5Fc");
  });

  it.each(["", " ", "../a", "a%5Fb", "á", "a\n"])(
    "rejects noncanonical component %j",
    (invalid) => {
      expect(() =>
        composePromptCacheKey({ sessionId: invalid, agentInstanceId: "agent" }),
      ).toThrow();
      expect(() =>
        composePromptCacheKey({ sessionId: "session", agentInstanceId: invalid }),
      ).toThrow();
    },
  );

  it("accepts exactly 512 composed characters and rejects overflow without truncating", () => {
    expect(
      composePromptCacheKey({ sessionId: "s".repeat(255), agentInstanceId: "a".repeat(256) }),
    ).toHaveLength(512);
    expect(() =>
      composePromptCacheKey({ sessionId: "s".repeat(256), agentInstanceId: "a".repeat(256) }),
    ).toThrow();
    expect(() =>
      composePromptCacheKey({ sessionId: "s" + "_".repeat(170), agentInstanceId: "a" }),
    ).toThrow();
  });
});
