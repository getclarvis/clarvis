import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPaths, workspacePaths } from "@clarvis/paths";
import { loadExecutionRules, writeExecutionRules } from "../../src/execution/execpolicy-loader.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "clarvis-execpolicy-"));
  roots.push(root);
  return { globalDir: join(root, "global"), workspaceRoot: join(root, "workspace") };
};
const doc = (id: string) =>
  JSON.stringify({ version: 1, rules: [{ id, pattern: ["git", "status"], decision: "allow" }] });

describe("execution rule loader", () => {
  test("loads lexical global and trusted workspace files with source identity", async () => {
    const dirs = await fixture();
    const global = globalPaths(dirs.globalDir).executionRulesDir;
    const workspace = workspacePaths(dirs.workspaceRoot).executionRulesDir;
    await mkdir(global, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(global, "z.json"), doc("z"));
    await writeFile(join(global, "a.json"), doc("a"));
    await writeFile(join(workspace, "b.json"), doc("b"));
    const loaded = await loadExecutionRules({ ...dirs, workspaceTrusted: true });
    expect(loaded.status).toBe("loaded");
    expect(loaded.sources.map((source) => source.rules[0]?.id)).toEqual(["a", "z", "b"]);
    expect(loaded.sources[0]?.digest).toStartWith("sha256:");
    const untrusted = await loadExecutionRules({ ...dirs, workspaceTrusted: false });
    expect(untrusted.sources).toHaveLength(2);
  });
  test("invalid file discards file layers but preserves host requirements", async () => {
    const dirs = await fixture();
    const dir = globalPaths(dirs.globalDir).executionRulesDir;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.json"), doc("a"));
    await writeFile(join(dir, "b.json"), "{");
    const loaded = await loadExecutionRules({
      ...dirs,
      workspaceTrusted: false,
      hostRequirements: [{ id: "host", pattern: ["git", "push"], decision: "forbidden" }],
    });
    expect(loaded.status).toBe("invalid_rules");
    expect(loaded.sources.map((source) => source.layer)).toEqual(["host"]);
    if (loaded.status !== "invalid_rules") throw new Error("expected invalid rules");
    expect(loaded.warning).toContain("b.json");
  });
  test("read failure is distinct from absent directory and invalid rules", async () => {
    const dirs = await fixture();
    expect((await loadExecutionRules({ ...dirs, workspaceTrusted: false })).status).toBe("loaded");
    const file = globalPaths(dirs.globalDir).executionRulesDir;
    await mkdir(dirs.globalDir, { recursive: true });
    await writeFile(file, "not a directory");
    expect((await loadExecutionRules({ ...dirs, workspaceTrusted: false })).status).toBe(
      "io_failure",
    );
  });
  test("validates replacement before writing and requires trusted workspace", async () => {
    const dirs = await fixture();
    const valid = JSON.parse(doc("status"));
    await writeExecutionRules({
      ...dirs,
      scope: "global",
      workspaceTrusted: false,
      operatorAction: true,
      document: valid,
      expectedRevision: null,
    });
    const file = globalPaths(dirs.globalDir).executionRulesFile;
    const original = await readFile(file, "utf8");
    await expect(
      writeExecutionRules({
        ...dirs,
        scope: "global",
        workspaceTrusted: false,
        operatorAction: true,
        document: { version: 1, rules: [{ id: "bad", pattern: [], decision: "allow" }] },
        expectedRevision: null,
      }),
    ).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe(original);
    await expect(
      writeExecutionRules({
        ...dirs,
        scope: "workspace",
        workspaceTrusted: false,
        operatorAction: true,
        document: valid,
        expectedRevision: null,
      }),
    ).rejects.toThrow();
  });

  test("defaults remembered writes to global and rejects host allows", async () => {
    const dirs = await fixture();
    const valid = JSON.parse(doc("status"));
    await writeExecutionRules({
      ...dirs,
      workspaceTrusted: false,
      operatorAction: true,
      document: valid,
      expectedRevision: null,
    });
    expect(await readFile(globalPaths(dirs.globalDir).executionRulesFile, "utf8")).toContain(
      "status",
    );
    await expect(
      loadExecutionRules({
        ...dirs,
        workspaceTrusted: false,
        hostRequirements: [{ id: "bad", pattern: ["git"], decision: "allow" }],
      }),
    ).rejects.toThrow();
  });
  test("rejects a stale rule revision without overwriting another writer", async () => {
    const dirs = await fixture();
    const document = JSON.parse(doc("first"));
    const first = await writeExecutionRules({
      ...dirs,
      operatorAction: true,
      workspaceTrusted: false,
      document,
      expectedRevision: null,
    });
    const file = globalPaths(dirs.globalDir).executionRulesFile;
    await expect(
      writeExecutionRules({
        ...dirs,
        operatorAction: true,
        workspaceTrusted: false,
        document: JSON.parse(doc("stale")),
        expectedRevision: null,
      }),
    ).rejects.toThrow("changed before save");
    expect(await readFile(file, "utf8")).toContain("first");
    await writeExecutionRules({
      ...dirs,
      operatorAction: true,
      workspaceTrusted: false,
      document: JSON.parse(doc("second")),
      expectedRevision: first,
    });
    expect(await readFile(file, "utf8")).toContain("second");
  });
});
