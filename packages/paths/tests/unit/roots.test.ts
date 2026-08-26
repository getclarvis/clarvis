import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  CLARVIS_DIR,
  globalRoot,
  HOME_ENV,
  ownerFromWorkspace,
  ownerSegment,
  setPathsLogger,
  workspaceRoot,
  workspaceScopeKey,
  worktreeCheckoutRoot,
  WORKSPACE_ENV,
} from "../../src/index.ts";

import { recorder } from "../helpers/recorder.ts";

describe("globalRoot", () => {
  test("defaults to <home>/.clarvis", () => {
    expect(globalRoot({ env: {}, home: "/home/alice" })).toBe(
      resolve(join("/home/alice", CLARVIS_DIR)),
    );
  });

  test("falls back to the ambient home when none is supplied", () => {
    expect(globalRoot({ env: {} })).toBe(resolve(join(homedir(), CLARVIS_DIR)));
  });

  test("CLARVIS_HOME overrides the home-derived default", () => {
    expect(globalRoot({ env: { [HOME_ENV]: "/srv/clarvis" }, home: "/home/alice" })).toBe(
      resolve("/srv/clarvis"),
    );
  });

  test("a blank or whitespace-only override reads as unset", () => {
    for (const raw of ["", "   "]) {
      expect(globalRoot({ env: { [HOME_ENV]: raw }, home: "/home/alice" })).toBe(
        resolve(join("/home/alice", CLARVIS_DIR)),
      );
    }
  });

  test("a relative override is resolved against the cwd", () => {
    expect(globalRoot({ env: { [HOME_ENV]: "rel-home" } })).toBe(resolve("rel-home"));
  });

  test("reads process.env when no env is supplied", () => {
    expect(globalRoot({ home: "/home/alice" })).toBe(
      process.env[HOME_ENV] === undefined || process.env[HOME_ENV].trim().length === 0
        ? resolve(join("/home/alice", CLARVIS_DIR))
        : resolve(process.env[HOME_ENV].trim()),
    );
  });
});

describe("workspaceRoot", () => {
  test("defaults to the supplied cwd, and names the tree — not its .clarvis dir", () => {
    const root = workspaceRoot({ env: {}, cwd: "/work/repo" });
    expect(root).toBe(resolve("/work/repo"));
    expect(root).not.toContain(CLARVIS_DIR);
  });

  test("falls back to the ambient cwd", () => {
    expect(workspaceRoot({ env: {} })).toBe(resolve(process.cwd()));
  });

  test("CLARVIS_WORKSPACE_ROOT overrides the cwd", () => {
    expect(workspaceRoot({ env: { [WORKSPACE_ENV]: "/other/tree" }, cwd: "/work/repo" })).toBe(
      resolve("/other/tree"),
    );
  });

  test("a blank override reads as unset", () => {
    expect(workspaceRoot({ env: { [WORKSPACE_ENV]: "  " }, cwd: "/work/repo" })).toBe(
      resolve("/work/repo"),
    );
  });

  test("reads process.env when no env is supplied", () => {
    const expected =
      process.env[WORKSPACE_ENV] === undefined || process.env[WORKSPACE_ENV].trim().length === 0
        ? resolve("/work/repo")
        : resolve(process.env[WORKSPACE_ENV].trim());
    expect(workspaceRoot({ cwd: "/work/repo" })).toBe(expected);
  });
});

describe("ownerFromWorkspace", () => {
  test("hashes the canonical absolute workspace as one safe owner id", () => {
    expect(ownerFromWorkspace("/a/b c")).toMatch(/^ws_[0-9a-f]{64}$/);
    expect(ownerFromWorkspace("/a/b c")).toBe(ownerFromWorkspace(resolve("/a/b c")));
    expect(ownerFromWorkspace("/a//b")).toBe(ownerFromWorkspace("/a/b"));
    expect(ownerFromWorkspace("/a/b")).not.toContain("/");
    expect(ownerFromWorkspace("/a/b")).not.toContain("\\");
  });

  test("does not collapse a nested workspace onto an underscore-shaped sibling", () => {
    expect(ownerFromWorkspace("/a/b")).not.toBe(ownerFromWorkspace("/a_b"));
  });

  test("resolves a relative path before encoding", () => {
    expect(ownerFromWorkspace(".")).toBe(ownerFromWorkspace(resolve(".")));
  });

  test("ignores the fallback whenever the resolved path is non-empty", () => {
    expect(ownerFromWorkspace("/x", "custom")).not.toBe("custom");
    expect(ownerFromWorkspace("/x", "custom")).toBe(ownerFromWorkspace(resolve("/x")));
  });

  test("never yields an empty id, whatever the input", () => {
    for (const input of ["/", "", ".", "//"]) {
      expect(ownerFromWorkspace(input).length).toBeGreaterThan(0);
    }
  });
});

describe("worktreeCheckoutRoot", () => {
  test("keeps the encoded name under the primary workspace's ignored Clarvis tree", () => {
    expect(worktreeCheckoutRoot("/workspace", "review.auth")).toBe(
      resolve("/workspace/.clarvis/worktrees/review%2Eauth"),
    );
  });
});

describe("workspaceScopeKey", () => {
  test("is stable for one identity and separates each identity component", () => {
    const scope = workspaceScopeKey("owner", "project", "workspace");
    expect(scope).toMatch(/^scope_[0-9a-f]{64}$/);
    expect(workspaceScopeKey("owner", "project", "workspace")).toBe(scope);
    expect(workspaceScopeKey("other", "project", "workspace")).not.toBe(scope);
    expect(workspaceScopeKey("owner", "other", "workspace")).not.toBe(scope);
    expect(workspaceScopeKey("owner", "project", "other")).not.toBe(scope);
  });
});

describe("ownerSegment", () => {
  test("leaves an already-safe id alone", () => {
    expect(ownerSegment("alice")).toBe("alice");
    expect(ownerSegment("exec_01JABC-xyz")).toBe("exec_01JABC-xyz");
  });

  test("encodes every separator, so the result is exactly one segment", () => {
    for (const raw of ["a/b", "a\\b", "../etc/passwd", "..", "."]) {
      const segment = ownerSegment(raw);
      expect(segment).not.toContain("/");
      expect(segment).not.toContain("\\");
      expect(segment).not.toBe(".");
      expect(segment).not.toBe("..");
    }
  });

  test("encodes the dot, which encodeURIComponent leaves alone", () => {
    expect(ownerSegment(".")).toBe("%2E");
    expect(ownerSegment("..")).toBe("%2E%2E");
    expect(ownerSegment("a.b")).toBe("a%2Eb");
  });

  test("encodes the rest of encodeURIComponent's unreserved punctuation", () => {
    expect(ownerSegment("!~*'()")).toBe("%21%7E%2A%27%28%29");
  });

  test("distinct owners never collide on one segment", () => {
    expect(ownerSegment("a/b")).not.toBe(ownerSegment("a_b"));
  });

  test("hashes an id whose encoded form would exceed the length bound", () => {
    const long = "x".repeat(201);
    const segment = ownerSegment(long);
    expect(segment).toMatch(/^h_[0-9a-f]{64}$/);
    expect(ownerSegment(long)).toBe(segment);
    expect(ownerSegment("x".repeat(202))).not.toBe(segment);
  });

  test("measures the bound in bytes, not characters", () => {
    expect(ownerSegment("é".repeat(100))).toMatch(/^h_[0-9a-f]{64}$/);
  });

  test("keeps a segment of exactly the bound verbatim", () => {
    expect(ownerSegment("x".repeat(200))).toBe("x".repeat(200));
  });

  test("rejects an empty id rather than resolving to the parent root", () => {
    expect(() => ownerSegment("")).toThrow(TypeError);
  });
});

describe("root resolution diagnostics", () => {
  afterEach(() => {
    setPathsLogger(null);
  });

  test("reports the global root once per process, and which input chose it", () => {
    const sink = recorder();
    setPathsLogger(sink.logger);
    const first = globalRoot({ env: { [HOME_ENV]: "/observed/global" }, home: "/home/observed" });
    globalRoot({ env: { [HOME_ENV]: "/observed/global" }, home: "/home/observed" });
    expect(sink.events("paths.roots_resolved")).toEqual([
      { event: "paths.roots_resolved", global_root: first, global_from: "env" },
    ]);
  });

  test("reports the workspace root and the fallback that produced it", () => {
    const sink = recorder();
    setPathsLogger(null);
    const root = workspaceRoot({ env: {}, cwd: "/observed/workspace", logger: sink.logger });
    expect(sink.events("paths.roots_resolved")).toEqual([
      { event: "paths.roots_resolved", workspace_root: root, workspace_from: "cwd" },
    ]);
  });
});
