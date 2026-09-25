import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentTools } from "../../src/index.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("host coding tools", () => {
  it("executes shell and file operations with process filesystem authority", async () => {
    const root = mkdtempSync(join(tmpdir(), "clarvis-open-tools-"));
    const outside = mkdtempSync(join(tmpdir(), "clarvis-open-target-"));
    roots.push(root, outside);
    const tools = createAgentTools({ workspaceRoot: root });
    const target = join(outside, "nested", "file.txt");
    const written = await tools.callTool("write_file", { path: target, content: "open needle" });
    expect(written.isError).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("open needle");

    const read = await tools.callTool("read_file", { path: target });
    expect(read.isError).toBe(false);

    const configuration = join(root, ".clarvis", "settings.json");
    const configured = await tools.callTool("write_file", {
      path: configuration,
      content: '{"workspace_setting":{"type":"native"}}',
    });
    expect(configured.isError).toBe(false);
    expect(readFileSync(configuration, "utf8")).toContain("workspace_setting");

    const command = await tools.callTool("shell", { command: "printf open" });
    expect(command.isError).toBe(false);
    expect(
      JSON.parse(command.content[0]?.type === "text" ? command.content[0].text : "{}"),
    ).toMatchObject({ exit_code: 0, stdout: "open" });

    const removed = await tools.callTool("remove", {
      path: join(outside, "nested"),
      recursive: true,
    });
    expect(removed.isError).toBe(false);
  });
});
