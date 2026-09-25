import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createAgentTools, currentShellFlavor } from "../../src/index.ts";
import { configurationRoots } from "@clarvis/paths";
import { makeWorkspace, cleanup, write, resultText } from "../helpers/fixtures.ts";
import { expectedToolNames } from "../helpers/tool-surface.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("createAgentTools (library API)", () => {
  let root: string;
  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => cleanup(root));

  it("lists the canonical public surface and exposes the resolved config", () => {
    const t = createAgentTools({ workspaceRoot: root });
    expect(t.config.workspaceRoot).toBe(root);
    expect(t.listTools().map(({ name }) => name)).toEqual(expectedToolNames({ readOnly: false }));
  });

  it("round-trips read_file / shell", async () => {
    const t = createAgentTools({ workspaceRoot: root });
    write(root, "a.txt", "alpha\nbeta\n");

    const r = await t.callTool("read_file", { path: "a.txt" });
    expect(r.isError).toBe(false);
    expect(resultText(r.content)).toContain("alpha");

    const b = await t.callTool("shell", { command: "echo hi" });
    expect(b.isError).toBe(false);
    expect(JSON.parse(resultText(b.content))).toMatchObject({ exit_code: 0 });
  });

  it("rejects home shorthand before creating a literal workspace directory", async () => {
    const t = createAgentTools({ workspaceRoot: root });
    const result = await t.callTool("write_file", { path: "~/probe.txt", content: "probe" });
    expect(JSON.parse(resultText(result.content))).toMatchObject({ error: "invalid_input" });
    expect(existsSync(join(root, "~"))).toBe(false);
  });

  it("reads and writes configuration paths with host permissions", async () => {
    const roots = configurationRoots({ workspaceRoot: root });
    const target = join(roots.workspace_clarvis, "agents/helper.md");
    const tools = createAgentTools({ workspaceRoot: root });
    const written = await tools.callTool("write_file", { path: target, content: "open" });
    expect(written.isError).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("open");
  });

  it("lets native tools read scratch created by shell inside the run-owned temporary root", async () => {
    const temporaryRoot = realpathSync(mkdtempSync(join(tmpdir(), "clarvis-run-owned-")));
    try {
      const t = createAgentTools({
        workspaceRoot: root,
        temporaryRoots: [temporaryRoot],
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

      const readBack = await t.callTool("read_file", { path: join(created, "a.txt") });
      expect(readBack.isError).toBe(false);
      expect(resultText(readBack.content)).toContain("alpha");
    } finally {
      cleanup(temporaryRoot);
    }
  });

  it("allows host file tools to edit a selected package", async () => {
    const packageRoot = realpathSync(mkdtempSync(join(tmpdir(), "clarvis-skill-package-")));
    try {
      write(packageRoot, "helper.txt", "packaged");
      const t = createAgentTools({
        workspaceRoot: root,
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
      expect(writeAttempt.isError).toBe(false);
      expect(readFileSync(join(packageRoot, "changed.txt"), "utf8")).toBe("no");
    } finally {
      cleanup(packageRoot);
    }
  });

  it("allows workspace mutations inside a selected package", async () => {
    const packageRoot = join(root, ".agents", "skills", "demo");
    mkdirSync(packageRoot, { recursive: true });
    const t = createAgentTools({
      workspaceRoot: root,
    });

    const writeAttempt = await t.callTool("write_file", {
      path: join(packageRoot, "changed.txt"),
      content: "no",
    });
    expect(writeAttempt.isError).toBe(false);

    write(packageRoot, "protected.txt", "unchanged");
    expect(readFileSync(join(packageRoot, "protected.txt"), "utf8")).toBe("unchanged");
  });

  it("read-only mode hides mutating tools and blocks writes", async () => {
    const t = createAgentTools({ workspaceRoot: root, readOnly: true });
    expect(t.listTools().map(({ name }) => name)).toEqual(expectedToolNames({ readOnly: true }));

    const w = await t.callTool("write_file", { path: "x.txt", content: "nope" });
    expect(w.isError).toBe(true);
    expect(JSON.parse(resultText(w.content))).toMatchObject({ error: "not_found" });
  });

  it("returns a not_found tool error for an unknown tool", async () => {
    const t = createAgentTools({ workspaceRoot: root });
    const r = await t.callTool("does_not_exist", {});
    expect(r.isError).toBe(true);
    expect(JSON.parse(resultText(r.content))).toMatchObject({ error: "not_found" });
  });

  it("defaults callTool args to an empty object", async () => {
    const t = createAgentTools({ workspaceRoot: root });
    const r = await t.callTool("list_dir");
    expect(r.isError).toBe(false);
  });

  it("does not mutate the caller's args object with schema defaults", async () => {
    const t = createAgentTools({ workspaceRoot: root });
    write(root, "a.txt", "alpha\n");
    const args = { path: "a.txt", offset: 1 };
    const r = await t.callTool("read_file", args);
    expect(r.isError).toBe(false);
    expect(Object.keys(args)).toEqual(["path", "offset"]);
  });

  it("accepts a frozen args object (defaults injected into a copy)", async () => {
    const t = createAgentTools({ workspaceRoot: root });
    write(root, "a.txt", "alpha\n");
    const r = await t.callTool("read_file", Object.freeze({ path: "a.txt" }));
    expect(r.isError).toBe(false);
    expect(resultText(r.content)).toContain("alpha");
  });
});
