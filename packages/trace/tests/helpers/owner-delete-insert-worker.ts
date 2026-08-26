import { existsSync, writeFileSync } from "node:fs";

import { createJsonTraceStore } from "@clarvis/trace";

import { makeExecutionRecord } from "./execution-record.ts";

const [dir, readyPath, startPath, resultPath] = process.argv.slice(2);

if (
  dir === undefined ||
  readyPath === undefined ||
  startPath === undefined ||
  resultPath === undefined
) {
  throw new Error("Expected trace dir and ready/start/result paths.");
}

writeFileSync(readyPath, "ready");
while (!existsSync(startPath)) await Bun.sleep(1);

let result: { ok: true } | { ok: false; code?: unknown; message: string };
try {
  await createJsonTraceStore({ dir }).insert(
    makeExecutionRecord({ id: "during-delete", owner_key_name: "alice", started_at: 2 }),
  );
  result = { ok: true };
} catch (error) {
  result = {
    ok: false,
    code: (error as { code?: unknown } | null)?.code,
    message: error instanceof Error ? error.message : String(error),
  };
}
writeFileSync(resultPath, JSON.stringify(result));
