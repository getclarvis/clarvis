/**
 * Drives the one backend-agnostic MemoryStore contract against every adapter,
 * including document, batch, revision, ledger and job-state semantics.
 * Behaviour that is specific to the file backend lives in file-store.test.ts.
 */
import { describe, test } from "bun:test";

import { createFileMemoryStore } from "../../src/file-store.ts";
import { createInMemoryMemoryStore, memoryStoreConformance } from "../../src/testing.ts";
import type { MemoryStoreHarness } from "../../src/testing.ts";
import { makeRoot, seedFile } from "../helpers/fs.ts";

/** The file-backed adapter over a fresh temp root; `poke` hand-edits a file. */
async function fileHarness(): Promise<MemoryStoreHarness> {
  const { root, cleanup } = await makeRoot();
  return {
    store: createFileMemoryStore({ root }),
    poke: (relPath, content) => seedFile(root, relPath, content),
    cleanup,
  };
}

/** The process-local adapter; `poke` writes straight through the store. */
function inMemoryHarness(): MemoryStoreHarness {
  const store = createInMemoryMemoryStore();
  return {
    store,
    poke: (relPath, content) => store.write(relPath, content),
    cleanup: async () => {},
  };
}

const backends: { name: string; make: () => Promise<MemoryStoreHarness> }[] = [
  { name: "file", make: fileHarness },
  { name: "in-memory", make: async () => inMemoryHarness() },
];

for (const backend of backends) {
  describe(`MemoryStore contract (${backend.name})`, () => {
    for (const scenario of memoryStoreConformance()) {
      test(scenario.name, async () => {
        const harness = await backend.make();
        try {
          await scenario.run(harness);
        } finally {
          await harness.cleanup();
        }
      });
    }
  });
}
