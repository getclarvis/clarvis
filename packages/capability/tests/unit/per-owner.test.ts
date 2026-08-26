import { describe, it, expect } from "../helpers/bun-test.ts";
import { memoizeByOwner, sharedFallback } from "../../src/per-owner.ts";

describe("memoizeByOwner", () => {
  it("builds each distinct owner at most once and caches the result", () => {
    const calls: string[] = [];
    const forOwner = memoizeByOwner((owner: string) => {
      calls.push(owner);
      return { owner };
    });

    const a1 = forOwner("alice");
    const a2 = forOwner("alice");
    const b1 = forOwner("bob");

    expect(a1).toBe(a2);
    expect(a1).not.toBe(b1);
    expect(calls).toEqual(["alice", "bob"]);
  });
});

describe("sharedFallback", () => {
  it("builds once and returns the same instance regardless of the owner argument", () => {
    let calls = 0;
    const provider = sharedFallback(() => {
      calls += 1;
      return { id: calls };
    });

    const a = provider("alice");
    const b = provider("bob");

    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it("composes with memoizeByOwner as its fallback build, collapsing every owner onto one instance", () => {
    let calls = 0;
    const forOwner = memoizeByOwner(
      sharedFallback(() => {
        calls += 1;
        return { id: calls };
      }),
    );

    expect(forOwner("alice")).toBe(forOwner("bob"));
    expect(calls).toBe(1);
  });

  it("still isolates per owner when a real per-owner factory is supplied instead of the fallback", () => {
    const suppliedFactory: ((owner: string) => { owner: string }) | undefined = (owner) => ({
      owner,
    });
    const forOwner = memoizeByOwner(suppliedFactory ?? sharedFallback(() => ({ owner: "shared" })));

    expect(forOwner("alice")).not.toBe(forOwner("bob"));
  });
});
