import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { tempRoot, type TempRootDeps } from "../helpers/temp-root.ts";

function fakeRoot(overrides: Partial<TempRootDeps> = {}) {
  const removals: string[] = [];
  return {
    removals,
    deps: {
      makeRoot: async () => "/tmp/clarvis-hooks-temp-fixture",
      removeRoot: async (root: string) => {
        removals.push(root);
      },
      ...overrides,
    },
  };
}

describe("tempRoot", () => {
  test("cleans registered resources in awaited LIFO order before removing the root", async () => {
    const events: string[] = [];
    const fixture = fakeRoot({
      removeRoot: async () => {
        events.push("root");
      },
    });
    const temp = await tempRoot("ignored-", fixture.deps);
    temp.register("child", async () => {
      await Promise.resolve();
      events.push("child");
    });
    temp.register("client", () => {
      events.push("client");
    });
    await temp.cleanup();
    expect(events).toEqual(["client", "child", "root"]);
    expect(temp.pending()).toEqual([]);
  });

  test("cleanup is idempotent", async () => {
    const fixture = fakeRoot();
    const temp = await tempRoot("ignored-", fixture.deps);
    await temp.cleanup();
    await temp.cleanup();
    expect(fixture.removals).toHaveLength(1);
  });

  test("retains a partially cleaned root and names the resource that failed", async () => {
    const events: string[] = [];
    const fixture = fakeRoot();
    const temp = await tempRoot("ignored-", fixture.deps);
    temp.register("early child", () => {
      events.push("early child");
    });
    temp.register("starting watcher", () => {
      events.push("starting watcher");
      throw new Error("not closed");
    });
    temp.register("pending client", () => {
      events.push("pending client");
    });
    await expect(temp.cleanup()).rejects.toThrow(/pending: starting watcher/);
    expect(events).toEqual(["pending client", "starting watcher", "early child"]);
    expect(temp.pending()).toEqual(["starting watcher"]);
    expect(fixture.removals).toHaveLength(0);
  });

  test("cleans resources registered before setup fails", async () => {
    const fixture = fakeRoot();
    const temp = await tempRoot("ignored-", fixture.deps);
    const events: string[] = [];
    try {
      temp.register("partially started child", () => {
        events.push("child closed");
      });
      throw new Error("setup failed");
    } catch (error) {
      expect(error).toMatchObject({ message: "setup failed" });
    } finally {
      await temp.cleanup();
    }
    expect(events).toEqual(["child closed"]);
    expect(temp.pending()).toEqual([]);
  });

  test("waits for a late child cleanup before removing its directory", async () => {
    const events: string[] = [];
    let release!: () => void;
    const exited = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fixture = fakeRoot({
      removeRoot: async () => {
        events.push("root");
      },
    });
    const temp = await tempRoot("ignored-", fixture.deps);
    temp.register("late child", async () => {
      events.push("kill");
      await exited;
      events.push("exited");
    });
    const cleanup = temp.cleanup();
    await Promise.resolve();
    expect(events).toEqual(["kill"]);
    release();
    await cleanup;
    expect(events).toEqual(["kill", "exited", "root"]);
  });

  test("reports a failed root removal without retrying", async () => {
    let attempts = 0;
    const fixture = fakeRoot({
      removeRoot: async () => {
        attempts += 1;
        throw new Error("root unavailable");
      },
    });
    const temp = await tempRoot("ignored-", fixture.deps);
    await expect(temp.cleanup()).rejects.toThrow(/pending: none/);
    expect(attempts).toBe(1);
  });

  test("returns confined child paths and removes a real root", async () => {
    const temp = await tempRoot("clarvis-hooks-temp-test-");
    const root = temp.root;
    expect(temp.path("nested/file")).toStartWith(root);
    expect(() => temp.path("../escape")).toThrow(/escapes/);
    expect(() => temp.path(root)).toThrow(/relative/);
    await temp.cleanup();
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
