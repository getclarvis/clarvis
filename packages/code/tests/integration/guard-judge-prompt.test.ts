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
  expect(DEFAULT_GUARD_JUDGE_PROMPT).toBe("");
});

test("operator-global guidance precedes workspace guidance; either can stand alone", () => {
  const dirs = tmpDirs();
  seed(dirs.global.guardJudgeFile, "global judge rules");
  expect(loadGuardJudgePrompt(dirs)).toEqual({ prompt: "global judge rules", source: "global" });
  seed(dirs.workspace.guardJudgeFile!, "workspace judge rules");
  expect(loadGuardJudgePrompt(dirs)).toEqual({
    prompt:
      "Operator-global guidance:\nglobal judge rules\n\nWorkspace guidance:\nworkspace judge rules",
    source: "global+workspace",
  });
});

test("a whitespace-only override file is ignored", () => {
  const dirs = tmpDirs();
  seed(dirs.workspace.guardJudgeFile!, "   \n  ");
  expect(loadGuardJudgePrompt(dirs).source).toBe("builtin");
});

test("the combined bound preserves operator-global guidance instead of replacing it", () => {
  const dirs = tmpDirs();
  const global = "global ".repeat(3_000);
  seed(dirs.global.guardJudgeFile, global);
  seed(dirs.workspace.guardJudgeFile!, "workspace ".repeat(3_000));
  expect(loadGuardJudgePrompt(dirs)).toEqual({ prompt: global, source: "global" });
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
