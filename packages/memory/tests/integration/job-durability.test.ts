import { describe, expect, test } from "bun:test";

import { createFileMemoryStore } from "../../src/file-store.ts";
import { createMemory } from "../../src/index.ts";
import { run } from "../helpers/fixtures.ts";
import { makeRoot } from "../helpers/fs.ts";

describe("file store job durability", () => {
  test("preserves the indexing instance and recovery execution across claims and reopen", async () => {
    const { root, cleanup } = await makeRoot();
    try {
      const first = createFileMemoryStore({ root });
      const queued = await first.exclusive((tx) =>
        tx.jobs.enqueue({
          run_id: "exec_subject",
          snapshot: run({ run_id: "exec_subject" }),
          at: 1,
        }),
      );
      const claim = await first.exclusive((tx) => tx.jobs.claim(2, { ms: 10, owner: "first" }));
      const reopened = createFileMemoryStore({ root });
      const resumed = await reopened.exclusive((tx) =>
        tx.jobs.claim(13, { ms: 10, owner: "second" }),
      );
      expect(queued.agent_instance_id).toBeString();
      expect(claim?.agent_instance_id).toBe(queued.agent_instance_id);
      expect(resumed?.agent_instance_id).toBe(queued.agent_instance_id);
      expect(resumed?.indexer_continue_from).toBe(claim?.indexer_execution_id);
      expect(resumed?.indexer_execution_id).not.toBe(claim?.indexer_execution_id);
      const afterEmptyClaim = await reopened.exclusive((tx) =>
        tx.jobs.claim(24, { ms: 10, owner: "third" }),
      );
      if (!claim?.indexer_execution_id || !resumed?.indexer_execution_id)
        throw new Error("Both successful claims must reserve execution IDs");
      expect(afterEmptyClaim?.indexer_prior_executions).toEqual([
        resumed.indexer_execution_id,
        claim.indexer_execution_id,
      ]);
      expect((await reopened.jobs.get("exec_subject"))?.indexer_execution_id).toBe(
        afterEmptyClaim?.indexer_execution_id,
      );
    } finally {
      await cleanup();
    }
  });

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
