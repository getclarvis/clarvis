import { describe, expect, test } from "bun:test";

import { createInMemoryMemoryStore } from "../../src/testing.ts";

describe("in-memory testing store edge behavior", () => {
  test("continues serializing exclusive work after a rejected operation", async () => {
    const store = createInMemoryMemoryStore();
    await expect(
      store.exclusive(() => Promise.reject(new Error("expected rejection"))),
    ).rejects.toThrow("expected rejection");
    await expect(store.exclusive(() => Promise.resolve("continued"))).resolves.toBe("continued");
  });

  test("trims UTF-8 bounded reads without splitting a code point", async () => {
    const store = createInMemoryMemoryStore();
    await store.write("a/MEMORY.md", "éclair");

    expect(await store.readBounded?.("a/MEMORY.md", 1)).toEqual({ text: "", truncated: true });
    expect(await store.readBounded?.("missing/MEMORY.md", 1)).toBeNull();
  });

  test("prunes old in-memory revision bodies after repeated batches", async () => {
    const store = createInMemoryMemoryStore({ clock: () => 100 * 86_400_000 });
    await store.write("a/MEMORY.md", "v0");
    for (let index = 1; index <= 24; index += 1) {
      await store.exclusive((tx) =>
        tx.batch({ source: { kind: "tool", tool: "write_memory" } }, (batch) =>
          batch.write("a/MEMORY.md", `v${String(index)}`),
        ),
      );
    }

    expect((await store.revisions.list("a/MEMORY.md")).length).toBeLessThanOrEqual(20);
  });
});
