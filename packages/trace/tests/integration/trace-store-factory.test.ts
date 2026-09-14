import { describe, it, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

  it("keeps records and cross-process locks in independently supplied roots", async () => {
    dir = mkdtempSync(join(tmpdir(), "clarvis-factory-"));
    const records = join(dir, "records");
    const locks = join(dir, "locks");
    const resolved = resolveTraceStore({ dir: records, locksDir: locks });
    await resolved.store.insert(makeExecutionRecord({ id: "split", owner_key_name: "owner" }));
    expect(resolved.store.getById("owner", "split")?.id).toBe("split");
    expect(existsSync(records)).toBe(true);
    expect(existsSync(locks)).toBe(true);
    expect(existsSync(join(records, ".locks"))).toBe(false);
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
