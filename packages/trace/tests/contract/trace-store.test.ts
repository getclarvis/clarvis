import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJsonTraceStore } from "@clarvis/trace";

import { createMemoryTraceStore } from "../../src/testing.ts";
import { traceStoreConformance } from "./trace-store-conformance.ts";

traceStoreConformance("memory", () => ({ store: createMemoryTraceStore() }));

traceStoreConformance("JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-trace-contract-"));
  return {
    store: createJsonTraceStore({ dir }),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
});
