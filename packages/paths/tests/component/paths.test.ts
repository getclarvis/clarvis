import { describe, expect, test } from "bun:test";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  AGENTS_DIR,
  AGENTS_PLUGINS_DIR,
  agentsMarketplaceFile,
  agentsMarketplaceFiles,
  agentsPluginsDir,
  agentsPluginsDirs,
  agentsSkillsDirs,
  CLARVIS_DIR,
  isAgentsMarketplaceFile,
  MARKETPLACE_FILE,
  CONTEXT_FILENAMES,
  globalPaths,
  HOME_ENV,
  INTERNAL_IGNORE_PATTERNS,
  INTERNAL_SKIP_DIRS,
  ownerSegment,
  TMP_GLOB,
  TMP_PREFIX,
  workspacePaths,
  workspaceStatePaths,
  WORKSPACE_ENV,
} from "../../src/index.ts";

const GLOBAL = "/home/alice/.clarvis";
const WS = "/work/repo";

describe("globalPaths", () => {
  const p = globalPaths(GLOBAL);

  test("nests only what the user never edits", () => {
    expect(p.root).toBe(GLOBAL);
    expect(p.state).toBe(join(GLOBAL, "state"));
    expect(p.cache).toBe(join(GLOBAL, "cache"));
    expect(new Set([p.root, p.state, p.cache]).size).toBe(3);
  });

  test("exports is a top-level sibling, not buried in state", () => {
    expect(p.exportsDirForOwner("alice")).toBe(join(GLOBAL, "exports", "alice"));
    for (const group of [p.state, p.cache]) {
      expect(p.exportsDirForOwner("alice").startsWith(group)).toBe(false);
    }
  });

  test("the operator's own files sit at the root, as they do in a workspace", () => {
    expect(p.settingsFile).toBe(join(GLOBAL, "settings.json"));
    expect(p.agentsDir).toBe(join(GLOBAL, "agents"));
    expect(p.keysFile).toBe(join(GLOBAL, "keys.json"));
    expect(p.subscriptionsFile).toBe(join(GLOBAL, "subscriptions.json"));
    expect(p.pluginsDir).toBe(join(GLOBAL, "plugins"));
    expect(p.extensionProfilesDir).toBe(join(GLOBAL, "extension-profiles"));
    expect(p.workspaceTrustFile).toBe(join(GLOBAL, "workspace-trust.json"));
    expect(p.skillsDir).toBe(join(GLOBAL, "skills"));
    expect(p.guardJudgeFile).toBe(join(GLOBAL, "guard-judge.md"));
    expect(p.memoryPolicyFile).toBe(join(GLOBAL, "memory-policy.md"));
    expect(p.authFile).toBe(join(GLOBAL, "auth.json"));
    expect(p.authKeyFile).toBe(join(GLOBAL, "auth-key.json"));
    expect(join(GLOBAL, "config")).not.toBe(p.settingsFile);
  });

  test("names the generated state and the cache", () => {
    expect(p.sessionsDir).toBe(join(p.state, "sessions"));
    expect(p.tracesDir).toBe(join(p.state, "traces"));
    expect(p.workflowRecordsDir).toBe(join(p.state, "workflows"));
    expect(p.mcpOAuthFile).toBe(join(p.state, "mcp-oauth.json"));
    expect(p.pluginDataRoot).toBe(join(p.state, "plugin-data"));
    expect(p.workflowsDir).toBe(join(p.root, "workflows"));
    expect(p.codeConfigFile).toBe(join(p.state, "code.json"));
    expect(p.extensionProfileSelectionFile).toBe(join(p.state, "extension-profile.json"));
    expect(p.modelsCacheFile).toBe(join(p.cache, "models-dev.json"));
    expect(p.updateCheckCacheFile).toBe(join(p.cache, "update-check.json"));
  });

  test("agentFile appends the markdown extension", () => {
    expect(p.agentFile("coder")).toBe(join(p.agentsDir, "coder.md"));
  });

  test("exportsDirForOwner encodes and separates raw owner ids", () => {
    expect(p.exportsDirForOwner("alice")).toBe(join(GLOBAL, "exports", "alice"));
    expect(p.exportsDirForOwner("a")).not.toBe(p.exportsDirForOwner("b"));
  });

  test("context candidates are absolute and ordered CLARVIS.md first", () => {
    expect(p.contextCandidates).toEqual(CONTEXT_FILENAMES.map((n) => join(GLOBAL, n)));
    expect(p.contextCandidates.every((c) => isAbsolute(c))).toBe(true);
  });

  test("resolves its own root from the environment when none is given", () => {
    expect(globalPaths(undefined, { env: { [HOME_ENV]: "/srv/c" } }).root).toBe(resolve("/srv/c"));
  });

  test("with no arguments at all it still produces an absolute root", () => {
    expect(isAbsolute(globalPaths().root)).toBe(true);
  });
});

describe("workspacePaths", () => {
  const p = workspacePaths(WS);

  // `workspacePaths` resolves its root, so every derived path hangs off
  // `p.root` and not off the literal `WS`. The two coincide on POSIX and part
  // company on Windows, where `resolve("/work/repo")` adopts the cwd's device.
  test("clarvisDir hangs off the tree root, and root stays the tree", () => {
    expect(p.root).toBe(resolve(WS));
    expect(p.clarvisDir).toBe(join(p.root, CLARVIS_DIR));
  });

  test("names the versioned workspace files", () => {
    expect(p.settingsFile).toBe(join(p.clarvisDir, "settings.json"));
    expect(p.agentsDir).toBe(join(p.clarvisDir, "agents"));
    expect(p.skillsDir).toBe(join(p.clarvisDir, "skills"));
    expect(p.pluginsDir).toBe(join(p.clarvisDir, "plugins"));
    expect(p.extensionProfilesDir).toBe(join(p.clarvisDir, "extension-profiles"));
    expect(p.guardJudgeFile).toBe(join(p.clarvisDir, "guard-judge.md"));
    expect(p.memoryPolicyFile).toBe(join(p.clarvisDir, "memory-policy.md"));
    expect(p.plansRoot).toBe(join(p.clarvisDir, "plans"));
    expect(p.memoryRoot).toBe(join(p.clarvisDir, "memory"));
  });

  test("owner roots separate plans from memory under one segment dir", () => {
    expect(p.plansRootForOwner("u1")).toBe(join(p.clarvisDir, "owners", "u1", "plans"));
    expect(p.memoryRootForOwner("u1")).toBe(join(p.clarvisDir, "owners", "u1", "memory"));
    expect(p.plansRootForOwner("u1")).not.toBe(p.plansRootForOwner("u2"));
  });

  test("the type offers no way to name machinery inside a working tree", () => {
    const machinery = [
      "localDir",
      "diagnosticsDir",
      "promptHistoryFile",
      "codeConfigFile",
      "extensionProfileSelectionFile",
      "monitorSidecar",
      "monitorLog",
      "monitorExit",
      "spillFile",
      "toolOutputSpill",
    ];
    for (const key of machinery) {
      expect(Object.hasOwn(p, key)).toBe(false);
    }
  });

  test("everything it does name is authored config or generated markdown", () => {
    const state = workspaceStatePaths(WS, { env: { [HOME_ENV]: GLOBAL } });
    for (const named of [
      p.settingsFile,
      p.agentsDir,
      p.skillsDir,
      p.workflowsDir,
      p.pluginsDir,
      p.extensionProfilesDir,
      p.guardJudgeFile,
      p.memoryPolicyFile,
      p.plansRoot,
      p.memoryRoot,
    ]) {
      expect(named.startsWith(p.clarvisDir)).toBe(true);
      expect(named.startsWith(state.root)).toBe(false);
    }
  });

  test("agentFile appends the markdown extension, matching globalPaths' shape", () => {
    expect(p.agentFile("coder")).toBe(join(p.agentsDir, "coder.md"));
  });

  test("workspace context candidates sit at the tree root, not inside .clarvis", () => {
    expect(p.contextCandidates).toEqual(CONTEXT_FILENAMES.map((n) => join(p.root, n)));
    for (const candidate of p.contextCandidates) {
      expect(candidate.startsWith(p.clarvisDir)).toBe(false);
    }
  });

  test("resolves a relative root and reads the environment when given none", () => {
    expect(workspacePaths("rel").root).toBe(resolve("rel"));
    expect(workspacePaths(undefined, { env: { [WORKSPACE_ENV]: "/t" } }).root).toBe(resolve("/t"));
    expect(isAbsolute(workspacePaths().root)).toBe(true);
  });
});

describe("agentsSkillsDirs", () => {
  test("names only the skills subdirectory, in both scopes", () => {
    const dirs = agentsSkillsDirs({ env: {}, home: "/home/alice", cwd: WS });
    expect(dirs.user).toBe(join("/home/alice", AGENTS_DIR, "skills"));
    expect(dirs.workspace).toBe(join(resolve(WS), AGENTS_DIR, "skills"));
  });

  test("is unaffected by CLARVIS_HOME — .agents is an ecosystem dir, not ours", () => {
    const dirs = agentsSkillsDirs({ env: { [HOME_ENV]: "/srv/c" }, home: "/home/alice", cwd: WS });
    expect(dirs.user).toBe(join("/home/alice", AGENTS_DIR, "skills"));
  });

  test("falls back to ambient home and cwd", () => {
    const dirs = agentsSkillsDirs();
    expect(isAbsolute(dirs.user)).toBe(true);
    expect(isAbsolute(dirs.workspace)).toBe(true);
  });
});

describe("agentsPluginsDir", () => {
  const expected = (root: string): string => join(resolve(root), AGENTS_DIR, AGENTS_PLUGINS_DIR);

  test("names the first-class shared plugin inventory under any root", () => {
    expect(agentsPluginsDir(WS)).toBe(expected(WS));
    expect(agentsPluginsDir("/home/alice")).toBe(expected("/home/alice"));
  });

  test("names both user and workspace inventories independently of CLARVIS_HOME", () => {
    const dirs = agentsPluginsDirs({
      env: { [HOME_ENV]: "/srv/c" },
      home: "/home/alice",
      cwd: WS,
    });
    expect(dirs.user).toBe(expected("/home/alice"));
    expect(dirs.workspace).toBe(expected(WS));
  });

  test("falls back to ambient home and cwd", () => {
    const dirs = agentsPluginsDirs();
    expect(isAbsolute(dirs.user)).toBe(true);
    expect(isAbsolute(dirs.workspace)).toBe(true);
  });
});

describe("agentsMarketplaceFile", () => {
  const expected = (root: string): string =>
    join(resolve(root), AGENTS_DIR, AGENTS_PLUGINS_DIR, MARKETPLACE_FILE);

  test("names the marketplace document under any root", () => {
    expect(agentsMarketplaceFile(WS)).toBe(expected(WS));
  });

  test("names it in both scopes, unaffected by CLARVIS_HOME", () => {
    const files = agentsMarketplaceFiles({
      env: { [HOME_ENV]: "/srv/c" },
      home: "/home/alice",
      cwd: WS,
    });
    expect(files.user).toBe(expected("/home/alice"));
    expect(files.workspace).toBe(expected(WS));
  });

  test("falls back to ambient home and cwd", () => {
    const files = agentsMarketplaceFiles();
    expect(isAbsolute(files.user)).toBe(true);
    expect(isAbsolute(files.workspace)).toBe(true);
  });

  test("the recogniser accepts what the builder produces, in either separator", () => {
    expect(isAgentsMarketplaceFile(agentsMarketplaceFile(WS))).toBe(true);
    expect(isAgentsMarketplaceFile(agentsMarketplaceFile("/home/alice"))).toBe(true);
    expect(isAgentsMarketplaceFile("C:\\work\\repo\\.agents\\plugins\\marketplace.json")).toBe(
      true,
    );
  });

  test("the recogniser rejects a document published anywhere else", () => {
    expect(isAgentsMarketplaceFile(join(resolve(WS), MARKETPLACE_FILE))).toBe(false);
    expect(isAgentsMarketplaceFile(MARKETPLACE_FILE)).toBe(false);
    expect(isAgentsMarketplaceFile(join(resolve(WS), AGENTS_DIR, MARKETPLACE_FILE))).toBe(false);
    expect(isAgentsMarketplaceFile("https://example.invalid/market.git")).toBe(false);
  });
});

describe("shared constants", () => {
  test("the temp glob is the temp prefix", () => {
    expect(TMP_GLOB).toBe(`${TMP_PREFIX}*`);
  });

  test("skip dirs bound a tree walk; ignore patterns feed an ignore file", () => {
    expect(INTERNAL_SKIP_DIRS).toContain(CLARVIS_DIR);
    expect(INTERNAL_SKIP_DIRS).toContain("node_modules");
    expect(INTERNAL_IGNORE_PATTERNS).toEqual([".git", CLARVIS_DIR, TMP_GLOB]);
  });

  test("neither list mentions .agents — it is the user's own content", () => {
    expect(INTERNAL_SKIP_DIRS).not.toContain(AGENTS_DIR);
    expect(INTERNAL_IGNORE_PATTERNS).not.toContain(AGENTS_DIR);
  });
});

describe("owner-derived path confinement", () => {
  const containedBy = (parent: string, child: string): boolean => {
    const rel = relative(parent, child);
    return rel !== "" && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
  };

  test("every owner builder encodes a traversal-shaped raw owner", () => {
    const g = globalPaths(GLOBAL);
    const w = workspacePaths(WS);
    const s = workspaceStatePaths(WS, { env: { [HOME_ENV]: GLOBAL } });

    for (const owner of ["../escape", "..\\escape"]) {
      const segment = ownerSegment(owner);
      const built: [parent: string, child: string][] = [
        [join(g.root, "exports"), g.exportsDirForOwner(owner)],
        [join(w.clarvisDir, "owners"), w.plansRootForOwner(owner)],
        [join(w.clarvisDir, "owners"), w.memoryRootForOwner(owner)],
        [join(s.root, "owners"), s.plansLockDirForOwner(owner)],
        [join(s.root, "owners"), s.memoryMachineryRootForOwner(owner)],
      ];

      for (const [parent, child] of built) {
        expect(containedBy(parent, child)).toBe(true);
        expect(child).toContain(segment);
      }
    }
  });
});

describe("portability", () => {
  // The root is resolved before it is handed over because `globalPaths` takes
  // an explicit root verbatim — unlike `workspacePaths`, which resolves. Only a
  // canonical root makes `value === resolve(value)` a statement about the
  // builders; on Windows a `/`-rooted literal is not canonical, since resolving
  // it prepends the cwd's device.
  test("no builder emits a hardcoded separator", () => {
    const g = globalPaths(resolve(GLOBAL));
    const w = workspacePaths(WS);
    const s = workspaceStatePaths(WS, { env: { [HOME_ENV]: resolve(GLOBAL) } });
    const built = [
      g.settingsFile,
      g.modelsCacheFile,
      g.exportsDirForOwner("o"),
      g.agentFile("a"),
      w.plansRoot,
      w.plansRootForOwner("o"),
      s.monitorSidecar("m"),
      s.spillFile("t", "stdout"),
    ];
    for (const value of built) {
      expect(value).toBe(resolve(value));
      if (sep === "\\") expect(value.includes("/")).toBe(false);
    }
  });
});
