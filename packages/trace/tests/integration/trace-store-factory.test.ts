import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTraceStore } from "@clarvis/trace";
import { globalPaths } from "@clarvis/paths";
import { makeExecutionRecord } from "../helpers/execution-record.ts";

let dir: string | undefined;
afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

describe("resolveTraceStore — durable JSON store", () => {
  it("honors an explicit dir and persists to it", async () => {
    dir = mkdtempSync(join(tmpdir(), "clarvis-factory-"));
    const resolved = resolveTraceStore({ dir });
    expect(resolved.path).toBe(dir);
    await resolved.store.insert(makeExecutionRecord({ id: "b", owner_key_name: "stdio" }));
    expect(resolved.store.getById("stdio", "b")?.id).toBe("b");
  });

  it("defaults to the global traces dir when no dir is given", () => {
    const resolved = resolveTraceStore();
    expect(resolved.path).toBe(globalPaths().tracesDir);
  });

  it("falls back to the default when dir is blank", () => {
    expect(resolveTraceStore({ dir: "" }).path).toBe(globalPaths().tracesDir);
    expect(resolveTraceStore({ dir: "   " }).path).toBe(globalPaths().tracesDir);
  });

  it("trims surrounding whitespace from an explicit dir", () => {
    dir = mkdtempSync(join(tmpdir(), "clarvis-factory-"));
    expect(resolveTraceStore({ dir: `  ${dir}  ` }).path).toBe(dir);
  });
});
