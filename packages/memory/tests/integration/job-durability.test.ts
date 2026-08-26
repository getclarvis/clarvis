import { describe, expect, test } from "bun:test";

import { createFileMemoryStore } from "../../src/file-store.ts";
import { createMemory } from "../../src/index.ts";
import { run } from "../helpers/fixtures.ts";
import { makeRoot } from "../helpers/fs.ts";

describe("file store job durability", () => {
  test("a queued run survives losing the process", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const first = createMemory({ store: createFileMemoryStore({ root }) });
      await first.enqueue(run({ run_id: "exec_survives" }));

      const reopened = createMemory({ store: createFileMemoryStore({ root }) });
      const jobs = await reopened.jobs();

      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.run_id).toBe("exec_survives");
      expect(jobs[0]?.snapshot).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  test("encodes an awkward run id without letting it escape the state directory", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const memory = createMemory({ store: createFileMemoryStore({ root }) });
      const nasty = "../../etc/passwd:CON";
      await memory.enqueue(run({ run_id: nasty }));

      const jobs = await memory.jobs();
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.run_id).toBe(nasty);
    } finally {
      await cleanup();
    }
  });
});
