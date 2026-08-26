import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DIR_MODE,
  ensureWorkspaceDir,
  ensureWorkspaceSubdir,
  setPathsLogger,
  workspacePaths,
  WORKSPACE_GITIGNORE,
} from "@clarvis/paths";

import { recorder } from "../helpers/recorder.ts";

const made: string[] = [];

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-paths-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  setPathsLogger(null);
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Mode bits are unobservable on Windows and meaningless under root. */
const modeBitsEnforced = process.platform !== "win32" && process.getuid?.() !== 0;

const ignoreOf = (dir: string): string => readFileSync(join(dir, ".gitignore"), "utf8");

describe("ensureWorkspaceDir", () => {
  test("creates .clarvis and seeds a selective .gitignore", () => {
    const ws = tempWorkspace();
    const dir = ensureWorkspaceDir(ws);
    expect(dir).toBe(workspacePaths(ws).clarvisDir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(ignoreOf(dir)).toBe(WORKSPACE_GITIGNORE);
  });

  test("the seeded ignore keeps a workspace's own config versioned", () => {
    const ws = tempWorkspace();
    const lines = ignoreOf(ensureWorkspaceDir(ws)).split("\n").filter(Boolean);
    expect(lines).toEqual([".gitignore", "plans/", "memory/", "owners/", "worktrees/"]);
    expect(lines).not.toContain("*");
    for (const kept of ["settings.json", "agents/", "skills/", "workflows/", "plugins/"]) {
      expect(lines).not.toContain(kept);
    }
  });

  test("it no longer ignores a local/ that no longer exists", () => {
    const ws = tempWorkspace();
    expect(ignoreOf(ensureWorkspaceDir(ws))).not.toContain("local/");
  });

  /** A workspace Clarvis has merely *run* in must report a clean `git status`;
   * the ignore file is Clarvis's own re-derivable rule, not the user's config. */
  test("it ignores itself, so a run leaves nothing for git to report", () => {
    const ws = tempWorkspace();
    expect(ignoreOf(ensureWorkspaceDir(ws)).split("\n")).toContain(".gitignore");
  });

  test("is idempotent", () => {
    const ws = tempWorkspace();
    expect(ensureWorkspaceDir(ws)).toBe(ensureWorkspaceDir(ws));
  });

  test("rejects lexical escapes before creating either workspace or target", () => {
    const ws = tempWorkspace();
    const p = workspacePaths(ws);
    const outside = join(ws, "outside");

    expect(() => ensureWorkspaceSubdir(outside, ws)).toThrow(/must be inside/);
    expect(() => ensureWorkspaceSubdir(p.clarvisDir, ws)).toThrow(/must be inside/);
    expect(() =>
      ensureWorkspaceSubdir(join(p.clarvisDir, "plans", "..", "..", "escape"), ws),
    ).toThrow(/must be inside/);
    expect(() => statSync(p.clarvisDir)).toThrow();
    expect(() => statSync(outside)).toThrow();
  });

  test.if(modeBitsEnforced)("creates the directory owner-only", () => {
    const ws = tempWorkspace();
    expect(statSync(ensureWorkspaceDir(ws)).mode & 0o777).toBe(DIR_MODE);
  });
});

describe("ensureWorkspaceSubdir", () => {
  test("creates the subdirectory and seeds the parent ignore in one call", () => {
    const ws = tempWorkspace();
    const p = workspacePaths(ws);
    expect(ensureWorkspaceSubdir(p.plansRoot, ws)).toBe(p.plansRoot);
    expect(statSync(p.plansRoot).isDirectory()).toBe(true);
    expect(ignoreOf(p.clarvisDir)).toBe(WORKSPACE_GITIGNORE);
  });

  test("is what keeps a generated tree from arriving before its ignore file", () => {
    const ws = tempWorkspace();
    const p = workspacePaths(ws);
    for (const dir of [p.plansRoot, p.memoryRoot, p.plansRootForOwner("u1")]) {
      ensureWorkspaceSubdir(dir, ws);
      expect(statSync(dir).isDirectory()).toBe(true);
      expect(ignoreOf(p.clarvisDir)).toBe(WORKSPACE_GITIGNORE);
    }
  });

  test("is idempotent", () => {
    const ws = tempWorkspace();
    const p = workspacePaths(ws);
    expect(ensureWorkspaceSubdir(p.memoryRoot, ws)).toBe(ensureWorkspaceSubdir(p.memoryRoot, ws));
  });

  test.if(modeBitsEnforced)("creates the directory owner-only", () => {
    const ws = tempWorkspace();
    expect(statSync(ensureWorkspaceSubdir(workspacePaths(ws).plansRoot, ws)).mode & 0o777).toBe(
      DIR_MODE,
    );
  });
});

describe("the ordering defect this replaces", () => {
  test("either call order leaves the identical ignore file", () => {
    const a = tempWorkspace();
    ensureWorkspaceDir(a);
    ensureWorkspaceSubdir(workspacePaths(a).plansRoot, a);

    const b = tempWorkspace();
    ensureWorkspaceSubdir(workspacePaths(b).plansRoot, b);
    ensureWorkspaceDir(b);

    expect(ignoreOf(workspacePaths(a).clarvisDir)).toBe(ignoreOf(workspacePaths(b).clarvisDir));
    expect(ignoreOf(workspacePaths(a).clarvisDir)).toBe(WORKSPACE_GITIGNORE);
  });

  test("a hand-edited ignore keeps its content and gains the mandatory worktree exclusion", () => {
    const ws = tempWorkspace();
    ensureWorkspaceDir(ws);
    const p = workspacePaths(ws);
    const mine = "# mine\n!plans/\n";
    writeFileSync(join(p.clarvisDir, ".gitignore"), mine);

    ensureWorkspaceSubdir(p.memoryRoot, ws);
    ensureWorkspaceDir(ws);

    expect(ignoreOf(p.clarvisDir)).toBe(`${mine}worktrees/\n`);
  });

  test("the mandatory worktree exclusion is appended once when the file has no final newline", () => {
    const ws = tempWorkspace();
    const p = workspacePaths(ws);
    ensureWorkspaceDir(ws);
    writeFileSync(join(p.clarvisDir, ".gitignore"), "# mine");
    ensureWorkspaceDir(ws);
    ensureWorkspaceDir(ws);
    expect(ignoreOf(p.clarvisDir)).toBe("# mine\nworktrees/\n");
  });
});

describe("ignore-file seeding diagnostics", () => {
  test("a skipped seed reports its errno, because only EEXIST is the normal one", () => {
    const ws = tempWorkspace();
    ensureWorkspaceDir(ws);
    const sink = recorder();
    setPathsLogger(sink.logger);
    ensureWorkspaceDir(ws);
    expect(sink.events("paths.gitignore_seed_skipped")[0]).toMatchObject({
      file: join(workspacePaths(ws).clarvisDir, ".gitignore"),
      code: "EEXIST",
    });
  });

  test("the first seed of a fresh workspace reports nothing", () => {
    const sink = recorder();
    setPathsLogger(sink.logger);
    ensureWorkspaceDir(tempWorkspace());
    expect(sink.events("paths.gitignore_seed_skipped")).toEqual([]);
  });

  test("an existing ignore path that cannot be updated fails with a warning", () => {
    const ws = tempWorkspace();
    const p = workspacePaths(ws);
    mkdirSync(p.clarvisDir, { recursive: true });
    mkdirSync(join(p.clarvisDir, ".gitignore"));
    const sink = recorder();
    setPathsLogger(sink.logger);
    expect(() => ensureWorkspaceDir(ws)).toThrow();
    expect(sink.events("paths.gitignore_update_failed")[0]).toMatchObject({
      file: join(p.clarvisDir, ".gitignore"),
    });
  });
});
