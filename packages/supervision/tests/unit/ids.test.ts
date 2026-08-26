import { describe, it, expect } from "bun:test";

import { AGENT_ID_PATTERN, mintAgentId } from "../../src/ids.ts";

describe("mintAgentId", () => {
  it("mints many unique ids in the canonical prefixed shape", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const id = mintAgentId(seen);
      expect(id).toMatch(AGENT_ID_PATTERN);
      seen.add(id);
    }
    expect(seen.size).toBe(200);
  });

  it("draws again when the first candidate is taken", () => {
    /**
     * A real collision is a 1-in-2^32 event, so the retry arm is unreachable
     * through `randomUUID` alone. `taken` is only ever consulted through `has`,
     * so a set that reports the first candidate as taken drives the loop around
     * exactly once — which is the contract the branch exists to honour.
     */
    class FirstCollisionSet extends Set<string> {
      readonly offered: string[] = [];

      override has(id: string): boolean {
        this.offered.push(id);
        return this.offered.length === 1;
      }
    }
    const taken = new FirstCollisionSet();

    const id = mintAgentId(taken);

    expect(taken.offered).toHaveLength(2);
    expect(id).toBe(taken.offered[1]!);
    expect(id).not.toBe(taken.offered[0]!);
    expect(id).toMatch(AGENT_ID_PATTERN);
  });
});

describe("AGENT_ID_PATTERN", () => {
  it("accepts exactly eight lowercase hex digits after the prefix", () => {
    expect(AGENT_ID_PATTERN.test("ag_0123abcd")).toBe(true);
    expect(AGENT_ID_PATTERN.test("ag_0123ABCD")).toBe(false);
    expect(AGENT_ID_PATTERN.test("ag_0123abc")).toBe(false);
    expect(AGENT_ID_PATTERN.test("ag_0123abcde")).toBe(false);
    expect(AGENT_ID_PATTERN.test("0123abcd")).toBe(false);
    expect(AGENT_ID_PATTERN.test("sub_0123abcd")).toBe(false);
  });
});
