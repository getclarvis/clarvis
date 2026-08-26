import { afterEach, describe, expect, it, vi } from "bun:test";
import { killTree, ownProcessGroup } from "../../src/lib/process.ts";

const DEAD_PID = 2_147_480_000;

describe("ownProcessGroup", () => {
  it("puts a POSIX child in its own group, so killTree can address it as -pid", () => {
    expect(ownProcessGroup("linux")).toBe(true);
    expect(ownProcessGroup("darwin")).toBe(true);
  });

  it("never detaches on Windows, where the flag means DETACHED_PROCESS instead", () => {
    expect(ownProcessGroup("win32")).toBe(false);
  });
});

describe("killTree — POSIX", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false when neither the group nor the pid can be signalled", () => {
    expect(killTree(DEAD_PID, "SIGTERM", { platform: "linux" })).toBe(false);
  });

  it("falls back to the bare pid when the group signal fails", () => {
    vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      if (pid < 0) throw new Error("no group");
      return true;
    });
    expect(killTree(4321, "SIGTERM", { platform: "linux" })).toBe(true);
  });

  it("addresses the process group as a negative pid", () => {
    const seen: number[] = [];
    vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      seen.push(pid);
      return true;
    });
    killTree(4321, "SIGTERM", { platform: "linux" });
    expect(seen).toEqual([-4321]);
  });
});

describe("killTree — Windows", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("invokes taskkill against the whole tree and reports success", () => {
    const calls: [string, string[]][] = [];
    const ok = killTree(4321, "SIGTERM", {
      platform: "win32",
      taskkill: (file, args) => {
        calls.push([file, args]);
        return { status: 0 };
      },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([["taskkill", ["/pid", "4321", "/T", "/F"]]]);
  });

  it("always forces the kill, because Windows has no signals to soften it with", () => {
    let args: string[] = [];
    killTree(99, "SIGTERM", {
      platform: "win32",
      taskkill: (_file, a) => {
        args = a;
        return { status: 0 };
      },
    });
    expect(args).toContain("/F");
  });

  it("falls back to a direct kill when taskkill fails", () => {
    const seen: number[] = [];
    vi.spyOn(process, "kill").mockImplementation((pid: number) => {
      seen.push(pid);
      return true;
    });
    const ok = killTree(4321, "SIGTERM", {
      platform: "win32",
      taskkill: () => ({ status: 1 }),
    });
    expect(ok).toBe(true);
    expect(seen).toEqual([4321]);
  });

  it("reports failure when taskkill and the direct kill both fail", () => {
    expect(
      killTree(DEAD_PID, "SIGTERM", { platform: "win32", taskkill: () => ({ status: null }) }),
    ).toBe(false);
  });

  it("degrades to false rather than throwing when the real taskkill is absent", () => {
    expect(killTree(DEAD_PID, "SIGTERM", { platform: "win32" })).toBe(false);
  });
});
