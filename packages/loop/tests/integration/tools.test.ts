import { afterEach, describe, expect, it } from "../bun-test.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceStatePaths } from "@clarvis/paths";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await harness?.close();
  harness = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "clarvis-tools-it-"));
  dirs.push(dir);
  return dir;
}

type ToolEvent = {
  type: string;
  mcp_name?: string;
  result?: string;
  error?: string | null;
  diff?: string;
};

function body(grants?: string[]): unknown {
  return {
    messages: [{ role: "user", content: "do it" }],
    servers: [],
    profiles: [
      {
        name: "solo",
        model: "anthropic/claude-haiku-4-5",
        tools: [],
        ...(grants !== undefined ? { grants } : {}),
        iteration_limit: 5,
      },
    ],
    entry: "solo",
    budget: { on_exceed: "stop", total_token_limit: 100_000, timeout_ms: 30_000 },
  };
}

async function toolEvents(id: string): Promise<ToolEvent[]> {
  const detail = await harness!.getRun(id);
  return (detail!.trace.events as unknown as ToolEvent[]).filter(
    (event) => event.type === "tool_call",
  );
}

describe("built-in tools adapter integrations", () => {
  it("wires edit/read effects and preserves unified diff metadata", async () => {
    const root = workspace();
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { id: "write", name: "write_file", arguments: { path: "out.txt", content: "one" } },
          ],
        },
        {
          toolCalls: [
            {
              id: "edit",
              name: "edit_file",
              arguments: { path: "out.txt", old_string: "one", new_string: "two" },
            },
            { id: "read", name: "read_file", arguments: { path: "out.txt" } },
          ],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: true,
    });

    const response = await harness.run(body(["edit_workspace"]));

    expect(response.status).toBe("completed");
    expect(readFileSync(join(root, "out.txt"), "utf8")).toBe("two");
    const calls = await toolEvents(response.execution_id);
    expect(calls.find((event) => event.mcp_name === "write_file")?.error).toBeNull();
    expect(calls.find((event) => event.mcp_name === "read_file")?.result).toContain("two");
    const edit = calls.find((event) => event.mcp_name === "edit_file");
    expect(edit?.diff).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(edit?.diff).toContain("-one");
    expect(edit?.diff).toContain("+two");
    expect(edit?.result).not.toContain("@@");
  });

  it("maps image content while the real read-only surface refuses mutation", async () => {
    const root = workspace();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    writeFileSync(join(root, "pixel.png"), png);
    const llm = new MockLLM({
      script: [
        {
          toolCalls: [
            { id: "image", name: "read_image", arguments: { path: "pixel.png" } },
            {
              id: "write",
              name: "write_file",
              arguments: { path: "forbidden.txt", content: "no" },
            },
          ],
        },
        { text: "done" },
      ],
    });
    harness = await makeHarness({
      llm,
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: true,
    });

    const response = await harness.run(body(["read_workspace"]));

    expect(response.status).toBe("completed");
    expect(existsSync(join(root, "forbidden.txt"))).toBe(false);
    const imageMessage = llm.calls[1]!.messages.find(
      (message) =>
        message.role === "tool" && (message as { tool_call_id?: string }).tool_call_id === "image",
    );
    expect((imageMessage as { images?: unknown }).images).toEqual([
      { data: png.toString("base64"), mediaType: "image/png" },
    ]);
    const calls = await toolEvents(response.execution_id);
    expect(calls.find((event) => event.mcp_name === "write_file")?.error).toContain("Unknown tool");
  });

  it("does not launch detached monitor cleanup from an ordinary run", async () => {
    const root = workspace();
    const paths = workspaceStatePaths(root);
    mkdirSync(paths.localDir, { recursive: true });
    const id = "mon_stale";
    const sidecar = paths.monitorSidecar(id);
    writeFileSync(
      sidecar,
      JSON.stringify({
        id,
        command: "done",
        cwd: root,
        pid: 2_147_480_000,
        startedAt: 1,
        readyWhen: null,
      }),
    );
    writeFileSync(paths.monitorLog(id), "old");
    harness = await makeHarness({
      llm: new MockLLM({ script: [{ text: "done" }] }),
      mcpFactory: mockMCPFactory({}),
      workspaceRoot: root,
      agentTools: true,
      env: { CLARVIS_AGENT_TOOLS_ENABLED: "false" },
    });

    await harness.run(body());
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(existsSync(sidecar)).toBe(true);
    expect(existsSync(paths.monitorLog(id))).toBe(true);
  });
});
