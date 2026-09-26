import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  DIR_MODE,
  ensureWorkspaceLocalDir,
  ensureWorkspaceStateDir,
  globalPaths,
  HOME_ENV,
  isSpillFile,
  ownerFromWorkspace,
  ownerSegment,
  TOOL_OUTPUT_PREFIX,
  TOOL_OUTPUT_SUFFIX,
  workspacePaths,
  workspaceStatePaths,
  workspaceStatePathsFromRoot,
  WORKSPACE_ENV,
} from "../../src/index.ts";

const GLOBAL = "/home/alice/.clarvis";
const WS = "/work/repo";
const env = { [HOME_ENV]: GLOBAL };
const p = workspaceStatePaths(WS, { env });

const made: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-wsstate-"));
  made.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Mode bits are unobservable under root. */
const modeBitsEnforced = process.getuid?.() !== 0;

describe("workspaceStatePaths", () => {
  test("roots under the global state tree, keyed by the workspace's segment", () => {
    const expected = join(
      globalPaths(undefined, { env }).state,
      "workspaces",
      ownerSegment(ownerFromWorkspace(resolve(WS))),
    );
    expect(p.root).toBe(expected);
    expect(p.workspaceRoot).toBe(resolve(WS));
  });

  test("keeps trace locks in the canonical workspace state namespace", () => {
    const segment = ownerSegment(ownerFromWorkspace(resolve(WS)));
    expect(p.root.endsWith(segment)).toBe(true);
    expect(p.traceLocksDir).toBe(join(p.root, "trace-locks"));
  });

  test("no path it builds is inside the working tree — the whole point", () => {
    const ws = workspacePaths(WS);
    const built = [
      p.root,
      p.localDir,
      p.diagnosticsDir,
      p.memoryMachineryRoot,
      p.plansLockDir,
      p.traceLocksDir,
      p.pluginDataRoot,
      p.promptHistoryFile,
      p.codeConfigFile,
      p.extensionProfileSelectionFile,
      p.toolOutputSpill("t"),
      p.memoryMachineryRootForOwner("u1"),
      p.plansLockDirForOwner("u1"),
    ];
    for (const value of built) {
      expect(value.startsWith(ws.root)).toBe(false);
      expect(value.startsWith(ws.clarvisDir)).toBe(false);
      expect(value.startsWith(p.root)).toBe(true);
    }
  });

  test("separator and underscore-shaped workspaces never share a state root", () => {
    const nested = workspaceStatePaths("/a/b", { env });
    const underscored = workspaceStatePaths("/a_b", { env });
    expect(nested.root).not.toBe(underscored.root);
    expect(nested.localDir).not.toBe(underscored.localDir);
  });

  test("names the machinery each package moved out of the workspace", () => {
    expect(p.localDir).toBe(join(p.root, "local"));
    expect(p.diagnosticsDir).toBe(join(p.localDir, "diagnostics"));
    expect(p.memoryMachineryRoot).toBe(join(p.root, "memory"));
    expect(p.plansLockDir).toBe(join(p.root, "plans"));
    expect(p.pluginDataRoot).toBe(join(p.root, "plugin-data"));
    expect(p.promptHistoryFile).toBe(join(p.localDir, "prompt-history"));
    expect(p.codeConfigFile).toBe(join(p.localDir, "code.json"));
    expect(p.extensionProfileSelectionFile).toBe(join(p.localDir, "extension-profile.json"));
  });

  test("owner roots separate a server's tenants under one segment dir", () => {
    expect(p.memoryMachineryRootForOwner("u1")).toBe(join(p.root, "owners", "u1", "memory"));
    expect(p.plansLockDirForOwner("u1")).toBe(join(p.root, "owners", "u1", "plans"));
    expect(p.memoryMachineryRootForOwner("u1")).not.toBe(p.memoryMachineryRootForOwner("u2"));
  });

  test("a tool-result spill is a single bounded text artifact", () => {
    expect(p.toolOutputSpill("tok")).toBe(
      join(p.localDir, `${TOOL_OUTPUT_PREFIX}tok${TOOL_OUTPUT_SUFFIX}`),
    );
  });

  test("resolves a relative root and reads the environment when given none", () => {
    expect(workspaceStatePaths("rel", { env }).workspaceRoot).toBe(resolve("rel"));
    const fromEnv = workspaceStatePaths(undefined, {
      env: { [HOME_ENV]: GLOBAL, [WORKSPACE_ENV]: "/t" },
    });
    expect(fromEnv.workspaceRoot).toBe(resolve("/t"));
    expect(isAbsolute(workspaceStatePaths().root)).toBe(true);
  });

  test("the global root override moves the whole tree", () => {
    const elsewhere = workspaceStatePaths(WS, { env: { [HOME_ENV]: "/srv/c" } });
    expect(elsewhere.root.startsWith(resolve("/srv/c"))).toBe(true);
  });

  test("rebuilds all state paths and builders from the host-selected root", () => {
    const stateRoot = join(tempDir(), "chosen", "workspace-state");
    const rebuilt = workspaceStatePathsFromRoot(WS, stateRoot);
    expect(rebuilt.root).toBe(stateRoot);
    expect(rebuilt.workspaceRoot).toBe(resolve(WS));
    expect(rebuilt.localDir).toBe(join(stateRoot, "local"));
    expect(rebuilt.memoryMachineryRootForOwner("a/b")).toBe(
      join(stateRoot, "owners", ownerSegment("a/b"), "memory"),
    );
    expect(rebuilt.plansLockDirForOwner("a/b")).toBe(
      join(stateRoot, "owners", ownerSegment("a/b"), "plans"),
    );
    expect(rebuilt.toolOutputSpill("token")).toBe(
      join(stateRoot, "local", `${TOOL_OUTPUT_PREFIX}token${TOOL_OUTPUT_SUFFIX}`),
    );
  });

  test("no builder emits a hardcoded separator", () => {
    for (const value of [p.root, p.localDir, p.toolOutputSpill("t")]) {
      expect(value).toBe(resolve(value));
      if (sep === "\\") expect(value.includes("/")).toBe(false);
    }
  });
});

describe("ensureWorkspaceStateDir / ensureWorkspaceLocalDir", () => {
  test("create the tree outside the workspace and seed no ignore file", () => {
    const home = tempDir();
    const ws = tempDir();
    const opts = { env: { [HOME_ENV]: join(home, ".clarvis") } };

    const local = ensureWorkspaceLocalDir(ws, opts);
    expect(local).toBe(workspaceStatePaths(ws, opts).localDir);
    expect(statSync(local).isDirectory()).toBe(true);
    expect(local.startsWith(resolve(ws))).toBe(false);
    expect(() => statSync(join(local, ".gitignore"))).toThrow();
    expect(() => statSync(join(resolve(ws), ".clarvis"))).toThrow();
  });

  test("are idempotent and agree on the root", () => {
    const home = tempDir();
    const ws = tempDir();
    const opts = { env: { [HOME_ENV]: join(home, ".clarvis") } };
    expect(ensureWorkspaceStateDir(ws, opts)).toBe(ensureWorkspaceStateDir(ws, opts));
    expect(ensureWorkspaceLocalDir(ws, opts).startsWith(ensureWorkspaceStateDir(ws, opts))).toBe(
      true,
    );
  });

  test.if(modeBitsEnforced)("create their directories owner-only", () => {
    const home = tempDir();
    const ws = tempDir();
    const opts = { env: { [HOME_ENV]: join(home, ".clarvis") } };
    expect(statSync(ensureWorkspaceLocalDir(ws, opts)).mode & 0o777).toBe(DIR_MODE);
    expect(statSync(ensureWorkspaceStateDir(ws, opts)).mode & 0o777).toBe(DIR_MODE);
  });
});

describe("filename predicates", () => {
  test("isSpillFile accepts what toolOutputSpill builds", () => {
    const built = p.toolOutputSpill("tok9");
    expect(isSpillFile(built.slice(built.lastIndexOf(sep) + 1))).toBe(true);
  });

  test("isSpillFile checks the suffix too, not just the prefix", () => {
    expect(isSpillFile("shell-tok.stdout.txt")).toBe(false);
    expect(isSpillFile("toolout-tok.log")).toBe(false);
  });

  test("legacy control and shell names are not generic result spills", () => {
    expect(isSpillFile("monitor-mon_1.json")).toBe(false);
    expect(isSpillFile("monitor-mon_1.log")).toBe(false);
    expect(isSpillFile("shell-tok.stdout.log")).toBe(false);
  });

  test("rejects unrelated names", () => {
    for (const name of ["settings.json", "prompt-history", "", "shell-no-suffix"]) {
      expect(isSpillFile(name)).toBe(false);
    }
  });
});
