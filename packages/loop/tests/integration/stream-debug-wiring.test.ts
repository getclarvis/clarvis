import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv, NOOP_LOGGER } from "@clarvis/capability";
import { buildExecuteRunDeps } from "#src/runtime/build-run-deps.ts";

describe("host-owned stream counters", () => {
  test("selects the debug sink from host environment and flushes it on disposal", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-stream-host-"));
    const path = join(root, "stream.jsonl");
    try {
      const built = await buildExecuteRunDeps({
        env: loadEnv({ CLARVIS_LOG_LEVEL: "silent" }),
        environment: { CLARVIS_STREAM_DEBUG: path },
        logger: NOOP_LOGGER,
        workspaceRoot: root,
        builtins: { tools: false, skills: false, hooks: false },
      });
      await built.dispose();
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!) as object).toMatchObject({ source: "loop", counts: {} });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
