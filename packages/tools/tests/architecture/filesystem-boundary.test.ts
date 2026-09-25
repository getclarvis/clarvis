import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_OPERATIONS } from "../../src/agent-filesystem.ts";
import { SandboxAgentFilesystem } from "../../src/filesystem-service.ts";
import { createAgentTools, tools as catalog } from "../../src/index.ts";

test("every model file handler crosses the Sandbox filesystem port before path I/O", async () => {
  const calls: string[] = [];
  const execute = spyOn(SandboxAgentFilesystem.prototype, "execute").mockImplementation(
    async (call) => {
      calls.push(call.operation);
      return { isError: false, content: [{ type: "text", text: "isolated" }] };
    },
  );
  const workspaceRoot = mkdtempSync(join(tmpdir(), "clarvis-file-boundary-"));
  const agent = createAgentTools({
    workspaceRoot,
    sandbox: { type: "native", filesystem: "workspace-write", network: "none" },
  });
  const samples: Record<(typeof FILE_OPERATIONS)[number], Record<string, unknown>> = {
    read_file: { path: "file.txt" },
    read_files: { paths: ["file.txt"] },
    read_image: { path: "image.png" },
    file_stat: { path: "file.txt" },
    list_dir: { path: "." },
    glob: { path: ".", pattern: "*.txt" },
    grep: { path: ".", pattern: "needle" },
    tree: { path: "." },
    diff: { from: "before.txt", to: "after.txt" },
    write_file: { path: "file.txt", content: "text" },
    edit_file: { path: "file.txt", old_string: "a", new_string: "b" },
    multi_edit: { path: "file.txt", edits: [{ old_string: "a", new_string: "b" }] },
    replace: { path: ".", glob: "*.txt", pattern: "a", replacement: "b" },
    apply_patch: { patch: "*** Begin Patch\n*** Add File: file.txt\n+text\n*** End Patch" },
    copy: { source: "before.txt", destination: "after.txt" },
    move: { source: "before.txt", destination: "after.txt" },
    mkdir: { path: "directory" },
    remove: { path: "file.txt" },
  };
  try {
    expect(new Set<string>(FILE_OPERATIONS)).toEqual(
      new Set(
        catalog
          .map((tool) => tool.name)
          .filter((name) => name !== "shell" && name !== "shell_session"),
      ),
    );
    for (const operation of FILE_OPERATIONS) {
      const result = await agent.callTool(operation, samples[operation]);
      expect(result.isError).toBe(false);
    }
    expect(calls).toEqual([...FILE_OPERATIONS]);
  } finally {
    await agent.close();
    execute.mockRestore();
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test("file tool handlers import filesystem calls only through the environment adapter", () => {
  for (const operation of FILE_OPERATIONS) {
    const path = fileURLToPath(
      new URL(`../../src/tools/${operation.replaceAll("_", "-")}.ts`, import.meta.url),
    );
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/from ["']node:(?:fs|child_process)(?:\/promises)?["']/);
    expect(source).not.toMatch(/\b(?:Bun\.spawn|spawn|execFile)\s*\(/);
  }
});
