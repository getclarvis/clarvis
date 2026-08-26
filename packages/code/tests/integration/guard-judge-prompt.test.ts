import { expect, test } from "bun:test";
import { closeSync, mkdirSync, openSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openTempDir } from "../helpers/tracked-temp.ts";
import {
  DEFAULT_GUARD_JUDGE_PROMPT,
  loadGuardJudgePrompt,
} from "../../src/adapters/guard-judge-prompt.ts";
import type { ClarvisDirs } from "../../src/adapters/agents.ts";
import { globalPaths, workspacePaths, type WorkspacePaths } from "@clarvis/paths";

function tmpDirs(): ClarvisDirs & { workspace: WorkspacePaths } {
  const root = openTempDir("clarvis-judge-prompt-");
  return {
    global: globalPaths(join(root, "global")),
    workspace: workspacePaths(join(root, "workspace")),
  };
}

function seed(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

test("falls back to the built-in prompt when no override file exists", () => {
  const dirs = tmpDirs();
  expect(loadGuardJudgePrompt(dirs)).toEqual({
    prompt: DEFAULT_GUARD_JUDGE_PROMPT,
    source: "builtin",
  });
  expect(DEFAULT_GUARD_JUDGE_PROMPT).toContain("decide");
  expect(DEFAULT_GUARD_JUDGE_PROMPT).toContain("not given the user's current request");
  expect(DEFAULT_GUARD_JUDGE_PROMPT).toContain("git restore");
  expect(DEFAULT_GUARD_JUDGE_PROMPT).toContain('choose "unsure" so the user decides');
  expect(DEFAULT_GUARD_JUDGE_PROMPT).toContain('tool named "host_vcs"');
  expect(DEFAULT_GUARD_JUDGE_PROMPT).toContain("never assume the sandbox boundary");
});

test("workspace override wins over global; global wins over builtin", () => {
  const dirs = tmpDirs();
  seed(dirs.global.guardJudgeFile, "global judge rules");
  expect(loadGuardJudgePrompt(dirs)).toEqual({ prompt: "global judge rules", source: "global" });
  seed(dirs.workspace.guardJudgeFile!, "workspace judge rules");
  expect(loadGuardJudgePrompt(dirs)).toEqual({
    prompt: "workspace judge rules",
    source: "workspace",
  });
});

test("a whitespace-only override file is ignored", () => {
  const dirs = tmpDirs();
  seed(dirs.workspace.guardJudgeFile!, "   \n  ");
  expect(loadGuardJudgePrompt(dirs).source).toBe("builtin");
});

test("an oversized sparse override is ignored without reading its body", () => {
  const dirs = tmpDirs();
  mkdirSync(dirname(dirs.workspace.guardJudgeFile!), { recursive: true });
  const fd = openSync(dirs.workspace.guardJudgeFile!, "w");
  try {
    truncateSync(dirs.workspace.guardJudgeFile!, 64 * 1024 * 1024);
  } finally {
    closeSync(fd);
  }
  expect(loadGuardJudgePrompt(dirs).source).toBe("builtin");
});
