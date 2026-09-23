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
  prepareConfigurationFileMutation,
  readConfigurationDocument,
  type ConfigurationMutationRequest,
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
  const call = (request: ConfigurationMutationRequest) =>
    prepareConfigurationFileMutation(roots, request).commit();
  const read = (root: keyof typeof roots, path: string) => {
    const document = readConfigurationDocument(roots, root, path);
    return { content: document?.content ?? null, revision: document?.revision ?? null };
  };
  return { home, roots, call, read };
}

describe("native configuration files", () => {
  it("validates shared Agent Skills with the discovery root rules before writing", () => {
    const f = fixture();
    for (const content of [
      "Review tests.",
      "---\nname: other\ndescription: Review tests\n---\nReview.",
      "---\nname: review\ndescription: Review tests\nallowed-tools: [Read]\n---\nReview.",
    ])
      expect(() =>
        f.call({
          operation: "write",
          root: "workspace_agents",
          path: "skills/review/SKILL.md",
          content,
          expected_revision: null,
        }),
      ).toThrow();
    const content =
      "---\nname: review\ndescription: Review tests\nallowed-tools: Read\n---\nReview.";
    expect(
      f.call({
        operation: "write",
        root: "workspace_agents",
        path: "skills/review/SKILL.md",
        content,
        expected_revision: null,
      }),
    ).toMatchObject({ written: true });
  });

  it("rejects invalid skill manifests and authority overrides before replacing valid bytes", () => {
    const f = fixture();
    for (const [path, invalid] of [
      ["skills/review/SKILL.md", "---\nname: review\nMissing closing fence"],
      ["agents/reviewer.md", "---\nsandbox: false\n---\nReview tests."],
    ] as const) {
      const content = "Review tests.\n";
      f.call({
        operation: "write",
        root: "workspace_clarvis",
        path,
        content,
        expected_revision: null,
      });
      expect(() =>
        f.call({
          operation: "write",
          root: "workspace_clarvis",
          path,
          content: invalid,
          expected_revision: settingsDocumentRevision(content),
        }),
      ).toThrow();
      expect(readFileSync(join(f.roots.workspace_clarvis, path), "utf8")).toBe(content);
    }
  });

  it("validates prospective workflow definitions before previewing or writing them", () => {
    const f = fixture();
    const root = "workspace_clarvis";
    const briefPath = "workflows/review/briefs/review.md";
    f.call({
      operation: "write",
      root,
      path: briefPath,
      content: "Review the requested scope.",
      expected_revision: null,
    });
    const path = "workflows/review/WORKFLOW.md";
    const invalid = `---
name: review
description: Review a scope.
rounds:
  - id: inspect
    type: free
    title: Inspect scope
    over: sometimes
    brief: briefs/review.md
---
Synthesize the review.
`;
    const request: ConfigurationMutationRequest = {
      operation: "write",
      root,
      path,
      content: invalid,
      expected_revision: null,
    };
    expect(() => prepareConfigurationFileMutation(f.roots, request).facts).toThrow(
      "is not a selector",
    );
    expect(() => f.call(request)).toThrow("is not a selector");
    expect(f.read(root, path)).toEqual({ content: null, revision: null });

    const content = invalid.replace("over: sometimes", "over: once");
    expect(prepareConfigurationFileMutation(f.roots, { ...request, content }).facts).toMatchObject({
      root,
      expectedRevision: null,
      surface: "authoring",
    });
    expect(f.call({ ...request, content })).toMatchObject({ written: true });
    expect(readFileSync(join(f.roots[root], path), "utf8")).toBe(content);
  });

  it("previews a complete mutation fact without applying the write", () => {
    const f = fixture();
    const request: ConfigurationMutationRequest = {
      operation: "write",
      root: "workspace_clarvis",
      path: "agents/reviewer.md",
      content: "Review carefully.\n",
      expected_revision: null,
    };
    expect(prepareConfigurationFileMutation(f.roots, request).facts).toMatchObject({
      root: "workspace_clarvis",
      expectedRevision: null,
      bytes: 18,
      surface: "authoring",
    });
    expect(f.read(request.root, request.path)).toEqual({
      content: null,
      revision: null,
    });
  });

  it("binds a prepared mutation to the captured revision before commit", () => {
    const f = fixture();
    const request: ConfigurationMutationRequest = {
      operation: "write",
      root: "workspace_clarvis",
      path: "agents/reviewer.md",
      content: "Reviewed bytes.\n",
      expected_revision: null,
    };
    const prepared = prepareConfigurationFileMutation(f.roots, request);
    expect(prepared.before).toBeNull();
    expect(prepared.facts.nextRevision).toBe(settingsDocumentRevision(request.content!));
    const file = join(f.roots.workspace_clarvis, request.path);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "Concurrent bytes.\n");
    expect(() => prepared.commit()).toThrow("revision conflict");
    expect(readFileSync(file, "utf8")).toBe("Concurrent bytes.\n");
  });

  it("preserves a UTF-8 BOM and CRLF when editing an authored workflow brief", () => {
    const f = fixture();
    const root = "global_clarvis";
    const path = "workflows/review/briefs/review.md";
    const content = "\uFEFFFirst line\r\nReview this\r\nLast line\r\n";
    f.call({ operation: "write", root, path, content, expected_revision: null });
    expect(f.read(root, path)).toEqual({
      content,
      revision: settingsDocumentRevision(content),
    });
    expect(readConfigurationDocument(f.roots, root, path)).toEqual({
      content,
      revision: settingsDocumentRevision(content),
      bytes: Buffer.from(content),
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
      expect(f.read(root, path)).toEqual({ content: null, revision: null });
      const content =
        "---\nname: example\ndescription: Example skill\n---\nFirst line\nChange me\nLast line\n";
      const revision = settingsDocumentRevision(content);
      expect(f.call({ operation: "write", root, path, content, expected_revision: null })).toEqual({
        written: true,
        revision,
      });
      expect(f.read(root, path)).toEqual({ content, revision });
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
      const updated =
        "---\nname: example\ndescription: Example skill\n---\nFirst line\nChanged\nLast line\n";
      expect(readFileSync(join(f.roots[root], path), "utf8")).toBe(updated);
      f.call({
        operation: "delete",
        root,
        path,
        expected_revision: settingsDocumentRevision(updated),
      });
      expect(f.read(root, path)).toEqual({ content: null, revision: null });
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
    expect(() => f.read("global_clarvis", path)).toThrow();
    for (const operation of ["write", "edit", "delete"] as const)
      expect(() =>
        f.call({ operation, root: "global_clarvis", path, content: "x", expected_revision: null }),
      ).toThrow();
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
    for (const path of ["skills/hardlink.md", "skills/link.md", "agents/outside.txt"]) {
      expect(() => f.read(root, path)).toThrow();
      for (const operation of ["write", "edit", "delete"] as const)
        expect(() =>
          f.call({ operation, root, path, content: "overwrite", expected_revision: null }),
        ).toThrow();
    }
    expect(readFileSync(secret, "utf8")).toBe("private-value");
  });

  it("rejects oversized and binary documents", () => {
    const f = fixture();
    mkdirSync(join(f.roots.global_clarvis, "skills"), { recursive: true });
    for (const bytes of [Buffer.alloc(262145, 65), Buffer.from([0xff])]) {
      writeFileSync(join(f.roots.global_clarvis, "skills", "bad.txt"), bytes);
      expect(() => f.read("global_clarvis", "skills/bad.txt")).toThrow();
    }
  });
});
