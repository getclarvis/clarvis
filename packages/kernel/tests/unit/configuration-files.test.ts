import { afterEach, describe, expect, it } from "bun:test";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationRoots } from "@clarvis/paths";
import {
  configurationFileOperation,
  type ConfigurationFileRequest,
} from "../../src/configuration/files.ts";
import { settingsDocumentRevision } from "../../src/config/config-store.ts";

const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "clarvis-configuration-files-"));
  cleanup.push(home);
  const workspaceRoot = join(home, "workspace");
  mkdirSync(workspaceRoot);
  const roots = configurationRoots({ home, workspaceRoot, globalDir: join(home, "global") });
  const call = (request: ConfigurationFileRequest) => configurationFileOperation(roots, request);
  return { home, roots, call };
}

describe("native configuration files", () => {
  it("preserves a UTF-8 BOM and CRLF when editing an authored workflow brief", () => {
    const f = fixture();
    const root = "global_clarvis";
    const path = "workflows/review/briefs/review.md";
    const content = "\uFEFFFirst line\r\nReview this\r\nLast line\r\n";
    f.call({ operation: "write", root, path, content, expected_revision: null });
    expect(f.call({ operation: "read", root, path })).toEqual({
      content,
      revision: settingsDocumentRevision(content),
    });
    f.call({
      operation: "edit",
      root,
      path,
      expected_revision: settingsDocumentRevision(content),
      old_text: "Review this",
      new_text: "Review that",
    });
    expect(readFileSync(join(f.roots[root], path))).toEqual(
      Buffer.from(content.replace("Review this", "Review that")),
    );
  });

  it.each(["global_clarvis", "workspace_clarvis", "global_agents", "workspace_agents"] as const)(
    "creates, reads, edits and deletes in %s with revision checks",
    (root) => {
      const f = fixture();
      const path = "skills/example/SKILL.md";
      expect(f.call({ operation: "read", root, path })).toEqual({ content: null, revision: null });
      const content = "First line\nChange me\nLast line\n";
      const revision = settingsDocumentRevision(content);
      expect(f.call({ operation: "write", root, path, content, expected_revision: null })).toEqual({
        written: true,
        revision,
      });
      expect(f.call({ operation: "read", root, path })).toEqual({ content, revision });
      expect(() =>
        f.call({
          operation: "edit",
          root,
          path,
          expected_revision: "stale",
          old_text: "Change me",
          new_text: "Changed",
        }),
      ).toThrow("revision conflict");
      f.call({
        operation: "edit",
        root,
        path,
        expected_revision: revision,
        old_text: "Change me",
        new_text: "Changed",
      });
      const updated = "First line\nChanged\nLast line\n";
      expect(readFileSync(join(f.roots[root], path), "utf8")).toBe(updated);
      expect(f.call({ operation: "list", root, path: "skills/example" })).toEqual({
        entries: [{ name: "SKILL.md", kind: "file" }],
        truncated: false,
      });
      f.call({
        operation: "delete",
        root,
        path,
        expected_revision: settingsDocumentRevision(updated),
      });
      expect(f.call({ operation: "read", root, path })).toEqual({ content: null, revision: null });
    },
  );

  it("rejects ambiguous edits, absent revisions, directories and invalid settings", () => {
    const f = fixture();
    const root = "global_clarvis";
    const path = "settings.json";
    f.call({ operation: "write", root, path, content: "{}", expected_revision: null });
    const expected_revision = settingsDocumentRevision("{}");
    expect(() => f.call({ operation: "write", root, path, content: "{}" })).toThrow("revision");
    expect(() =>
      f.call({
        operation: "edit",
        root,
        path,
        expected_revision,
        old_text: "missing",
        new_text: "",
      }),
    ).toThrow("exactly once");
    expect(() =>
      f.call({ operation: "edit", root, path, expected_revision, old_text: "", new_text: "" }),
    ).toThrow("nonempty");
    expect(() =>
      f.call({
        operation: "edit",
        root,
        path,
        expected_revision,
        old_text: "{}",
        new_text: "bad json",
      }),
    ).toThrow("settings schema");
    expect(() => f.call({ operation: "delete", root, path: "", expected_revision: null })).toThrow(
      "file",
    );
    const skill = "skills/repeated/SKILL.md";
    f.call({
      operation: "write",
      root,
      path: skill,
      content: "same\nsame",
      expected_revision: null,
    });
    expect(() =>
      f.call({
        operation: "edit",
        root,
        path: skill,
        expected_revision: settingsDocumentRevision("same\nsame"),
        old_text: "same",
        new_text: "different",
      }),
    ).toThrow("exactly once");
    expect(readFileSync(join(f.roots[root], path), "utf8")).toBe("{}");
  });

  it.each([
    "keys.json",
    "subscriptions.json",
    "auth.json",
    "auth-key.json",
    "workspace-trust.json",
    "state/mcp-oauth.json",
    "cache/models.json",
    "exports/session.json",
    "worktrees/repo/file",
    "../keys.json",
    "/settings.json",
    "agents/../../keys.json",
    "agents\\escape.md",
    "skills/example/.env",
    "plugins/example/credentials.json",
    "plugins/example/key.pem",
    "plugins/example/.git/config",
    "skills/example/token.json",
    "agents/../settings.json",
    "settings.json:stream",
    "settings.json.",
    "agents/\0bad.md",
    "plugins/test/NUL",
    "skills/COM1.md",
  ])("refuses private and escaping paths: %s", (path) => {
    const f = fixture();
    for (const operation of ["list", "read", "write", "edit", "delete"] as const)
      expect(() =>
        f.call({ operation, root: "global_clarvis", path, content: "x", expected_revision: null }),
      ).toThrow();
  });

  it("excludes private root entries without returning their contents", () => {
    const f = fixture();
    mkdirSync(f.roots.global_clarvis);
    writeFileSync(join(f.roots.global_clarvis, "keys.json"), "private-value");
    writeFileSync(join(f.roots.global_clarvis, "settings.json"), "{}");
    expect(f.call({ operation: "list", root: "global_clarvis", path: "" })).toEqual({
      entries: [{ name: "settings.json", kind: "file" }],
      truncated: false,
    });
  });

  it("rejects linked directories, linked leaves and hardlinks to credentials", () => {
    const f = fixture();
    const root = "global_clarvis";
    mkdirSync(f.roots[root]);
    const secret = join(f.home, "outside.txt");
    writeFileSync(secret, "private-value");
    mkdirSync(join(f.roots[root], "skills"));
    linkSync(secret, join(f.roots[root], "skills", "hardlink.md"));
    symlinkSync(secret, join(f.roots[root], "skills", "link.md"));
    symlinkSync(
      f.home,
      join(f.roots[root], "agents"),
      process.platform === "win32" ? "junction" : "dir",
    );
    for (const path of ["skills/hardlink.md", "skills/link.md", "agents/outside.txt"])
      for (const operation of ["read", "write", "edit", "delete"] as const)
        expect(() =>
          f.call({ operation, root, path, content: "overwrite", expected_revision: null }),
        ).toThrow();
    expect(readFileSync(secret, "utf8")).toBe("private-value");
  });

  it("rejects oversized and binary documents", () => {
    const f = fixture();
    mkdirSync(join(f.roots.global_clarvis, "skills"), { recursive: true });
    for (const bytes of [Buffer.alloc(262145, 65), Buffer.from([0xff])]) {
      writeFileSync(join(f.roots.global_clarvis, "skills", "bad.txt"), bytes);
      expect(() =>
        f.call({ operation: "read", root: "global_clarvis", path: "skills/bad.txt" }),
      ).toThrow();
    }
  });
});
