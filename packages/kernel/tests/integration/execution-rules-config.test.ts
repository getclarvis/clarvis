import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOOP_LOGGER } from "@clarvis/capability";
import { createConfigService } from "#src/config/config-service.ts";
import { createFileConfigStore } from "#src/config/file-config-store.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("rule check is read-only and a stale revision cannot replace another operator edit", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-rule-config-"));
  roots.push(root);
  const globalDir = join(root, "global");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot);
  const store = createFileConfigStore({ globalDir, workspaceRoot, logger: NOOP_LOGGER });
  const service = createConfigService(store, { executionRulePaths: { globalDir, workspaceRoot } });
  const before = await service.getExecutionRules();
  expect(before.revisions.global).toBeNull();
  const doc = {
    version: 1 as const,
    rules: [{ id: "block", pattern: ["git", "push"], decision: "forbidden" as const }],
  };
  const after = await service.updateExecutionRules("global", doc, null);
  expect(after.revisions.global).toStartWith("sha256:");
  await expect(
    service.updateExecutionRules("global", { version: 1, rules: [] }, null),
  ).rejects.toMatchObject({ code: "conflict" });
  const check = await service.checkExecutionRule("git push origin main", workspaceRoot);
  expect(check.decision).toBe("forbidden");
  expect(check.needsApproval).toBe(false);
  expect(check.matches.map((item) => item.id)).toEqual(["block"]);
  expect((await service.checkExecutionRule("git status", workspaceRoot)).decision).toBe("allow");
});

test("rule checks retain mandatory filesystem restrictions in bypass eligibility", async () => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-rule-required-"));
  roots.push(root);
  const globalDir = join(root, "global");
  const workspaceRoot = join(root, "workspace");
  mkdirSync(workspaceRoot);
  const store = createFileConfigStore({ globalDir, workspaceRoot, logger: NOOP_LOGGER });
  const service = createConfigService(store, { executionRulePaths: { globalDir, workspaceRoot } });
  await service.updateExecutionRules(
    "global",
    {
      version: 1,
      rules: [{ id: "status", pattern: ["git", "status"], decision: "allow" }],
    },
    null,
  );
  expect((await service.checkExecutionRule("git status", workspaceRoot)).bypassEligible).toBe(true);
  for (const requirements of [
    { read_only_paths: [join(workspaceRoot, "protected")] },
    { deny_read_paths: [join(workspaceRoot, "private")] },
  ]) {
    store.writeSettings("global", { execution_requirements: requirements });
    const check = await service.checkExecutionRule("git status", workspaceRoot);
    expect(check.decision).toBe("allow");
    expect(check.bypassEligible).toBe(false);
  }
});
