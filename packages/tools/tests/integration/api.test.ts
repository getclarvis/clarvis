import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAgentTools, currentShellFlavor } from "../../src/index.ts";
import { makeWorkspace, cleanup, write, resultText, posixShell } from "../helpers/fixtures.ts";
import { expectedToolNames } from "../helpers/tool-surface.ts";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("createAgentTools (library API)", () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("lists the canonical public surface and exposes the resolved config", () => {
    const t = createAgentTools({ workspaceRoot: root, probeRipgrep: () => false });
    expect(t.config.workspaceRoot).toBe(root);
    expect(t.config.ripgrepAvailable).toBe(false);
    expect(t.listTools().map(({ name }) => name)).toEqual(expectedToolNames({ readOnly: false }));
  });

  it("round-trips read_file / grep / bash", async () => {
    const t = createAgentTools({ workspaceRoot: root, probeRipgrep: () => false });
    write(root, "a.txt", "alpha\nbeta\n");

    const r = await t.callTool("read_file", { path: "a.txt" });
    expect(r.isError).toBe(false);
    expect(resultText(r.content)).toContain("alpha");

    const g = await t.callTool("grep", { pattern: "beta" });
    expect(g.isError).toBe(false);
    expect(resultText(g.content)).toContain("a.txt");

    const b = await t.callTool("shell", { command: "echo hi" });
    expect(b.isError).toBe(false);
    expect(JSON.parse(resultText(b.content))).toMatchObject({ exit_code: 0 });
  });

  it("lets native tools read scratch created by shell inside the run-owned temporary root", async () => {
    const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "clarvis-run-owned-")));
    try {
      const t = createAgentTools({
        workspaceRoot: root,
        temporaryRoots: [temporaryRoot],
        probeRipgrep: () => false,
      });
      const made = await t.callTool("shell", {
        command:
          currentShellFlavor() === "powershell"
            ? '$made = Join-Path $env:TEMP "shell-created"; [IO.Directory]::CreateDirectory($made) | Out-Null; [IO.File]::WriteAllText((Join-Path $made "a.txt"), "alpha"); [Console]::Out.Write($made)'
            : 'made=$(mktemp -d "$TMPDIR/clarvis.XXXXXX") && printf alpha > "$made/a.txt" && printf %s "$made"',
      });
      expect(made.isError).toBe(false);
      const created = JSON.parse(resultText(made.content)).stdout as string;
      expect(realpathSync(created).startsWith(temporaryRoot)).toBe(true);

      const searched = await t.callTool("grep", { path: created, pattern: "alpha" });
      expect(searched.isError).toBe(false);
      expect(resultText(searched.content)).toContain("a.txt");

      const refused = await t.callTool("grep", { path: tmpdir(), pattern: "alpha" });
      expect(refused.isError).toBe(true);
      expect(JSON.parse(resultText(refused.content))).toMatchObject({ error: "path_escape" });
    } finally {
      cleanup(temporaryRoot);
    }
  });

  it("admits a selected package only as a command working directory", async () => {
    const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), "clarvis-skill-package-")));
    try {
      write(packageRoot, "helper.txt", "packaged");
      const t = createAgentTools({
        workspaceRoot: root,
        skillExecutionRoots: [packageRoot],
        probeRipgrep: () => false,
      });
      const ran = await t.callTool("shell", {
        command:
          currentShellFlavor() === "powershell"
            ? "[Console]::Out.Write((Get-Content helper.txt -Raw))"
            : 'printf %s "$(cat helper.txt)"',
        cwd: packageRoot,
      });
      expect(ran.isError).toBe(false);
      expect(JSON.parse(resultText(ran.content)).stdout).toBe("packaged");

      const writeAttempt = await t.callTool("write_file", {
        path: join(packageRoot, "changed.txt"),
        content: "no",
      });
      expect(writeAttempt.isError).toBe(true);
      expect(JSON.parse(resultText(writeAttempt.content))).toMatchObject({ error: "path_escape" });
    } finally {
      cleanup(packageRoot);
    }
  });

  it("protects a selected package under the workspace from native mutations", async () => {
    const packageRoot = join(root, ".agents", "skills", "demo");
    mkdirSync(packageRoot, { recursive: true });
    const t = createAgentTools({
      workspaceRoot: root,
      skillExecutionRoots: [packageRoot],
      probeRipgrep: () => false,
    });

    const writeAttempt = await t.callTool("write_file", {
      path: join(packageRoot, "changed.txt"),
      content: "no",
    });
    expect(writeAttempt.isError).toBe(true);
    expect(JSON.parse(resultText(writeAttempt.content))).toMatchObject({ error: "path_escape" });
  });

  it.skipIf(!posixShell)(
    "adopts an explicit mktemp directory created by this shell call, but not generic /tmp",
    async () => {
      const prefix = `clarvis-explicit-${process.pid}-${Date.now()}`;
      const template = join(realpathSync(tmpdir()), `${prefix}-XXXXXX`);
      const record = join(root, "created-temp-path.txt");
      let created: string | undefined;
      try {
        const registered: string[] = [];
        const t = createAgentTools({
          workspaceRoot: root,
          probeRipgrep: () => false,
          onTemporaryRootRegistered: (path) => registered.push(path),
        });
        const made = await t.callTool("shell", {
          command: `made=$(mktemp -d ${template}) && printf alpha > "$made/a.txt" && printf %s "$made" > ${record}`,
        });
        expect(made.isError).toBe(false);
        created = readFileSync(record, "utf8");
        expect(registered).toEqual([created]);

        const searched = await t.callTool("grep", { path: created, pattern: "alpha" });
        expect(searched.isError).toBe(false);
        expect(resultText(searched.content)).toContain("a.txt");

        const refused = await t.callTool("grep", { path: tmpdir(), pattern: "alpha" });
        expect(refused.isError).toBe(true);
        expect(JSON.parse(resultText(refused.content))).toMatchObject({ error: "path_escape" });
      } finally {
        if (created !== undefined) cleanup(created);
      }
    },
  );

  it("read-only mode hides mutating tools and blocks writes", async () => {
    const t = createAgentTools({ workspaceRoot: root, readOnly: true, probeRipgrep: () => false });
    expect(t.listTools().map(({ name }) => name)).toEqual(expectedToolNames({ readOnly: true }));

    const w = await t.callTool("write_file", { path: "x.txt", content: "nope" });
    expect(w.isError).toBe(true);
    expect(JSON.parse(resultText(w.content))).toMatchObject({ error: "not_found" });
  });

  it("returns a not_found tool error for an unknown tool", async () => {
    const t = createAgentTools({ workspaceRoot: root, probeRipgrep: () => false });
    const r = await t.callTool("does_not_exist", {});
    expect(r.isError).toBe(true);
    expect(JSON.parse(resultText(r.content))).toMatchObject({ error: "not_found" });
  });

  it("defaults callTool args to an empty object", async () => {
    const t = createAgentTools({ workspaceRoot: root, probeRipgrep: () => false });
    const r = await t.callTool("list_dir");
    expect(r.isError).toBe(false);
  });

  it("does not mutate the caller's args object with schema defaults", async () => {
    const t = createAgentTools({ workspaceRoot: root, probeRipgrep: () => false });
    write(root, "a.txt", "alpha\n");
    const args = { pattern: "alpha" };
    const r = await t.callTool("grep", args);
    expect(r.isError).toBe(false);
    expect(Object.keys(args)).toEqual(["pattern"]);
  });

  it("accepts a frozen args object (defaults injected into a copy)", async () => {
    const t = createAgentTools({ workspaceRoot: root, probeRipgrep: () => false });
    write(root, "a.txt", "alpha\n");
    const r = await t.callTool("grep", Object.freeze({ pattern: "alpha" }));
    expect(r.isError).toBe(false);
    expect(resultText(r.content)).toContain("a.txt");
  });
});
