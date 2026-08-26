import { describe, it, expect, afterEach } from "../bun-test.ts";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";
import { contentToText } from "@clarvis/capability";
import type { ContextSnapshotEntry } from "@clarvis/capability";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let harness: TestHarness | null = null;
let workspace: string | undefined;
afterEach(async () => {
  await harness?.close();
  harness = null;
  if (workspace !== undefined) rmSync(workspace, { recursive: true, force: true });
  workspace = undefined;
});

const FS_TOOLS = [
  {
    name: "filesystem",
    transport: "stdio" as const,
    command: "node",
    args: ["-e", ""],
  },
];

const fsFactory = () =>
  mockMCPFactory({
    filesystem: {
      tools: [
        {
          name: "read",
          inputSchema: { type: "object", properties: { path: { type: "string" } } },
          call: () => "my-host\n",
        },
      ],
    },
  });

function texts(entries: ContextSnapshotEntry[]): string[] {
  return entries.map((e) => contentToText(e.message.content));
}

describe("final_context capture", () => {
  it("persists the entry agent's full live context on completion, without the system head", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "/etc/hostname" } }] },
        { text: "The hostname is 'my-host'." },
      ],
    });
    workspace = mkdtempSync(join(tmpdir(), "clarvis-final-capture-"));
    harness = await makeHarness({ llm, mcpFactory: fsFactory(), workspaceRoot: workspace });

    const res = await harness.run({
      messages: [{ role: "user", content: "Read /etc/hostname" }],
      servers: FS_TOOLS,
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["filesystem.read"],
          iteration_limit: 10,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 10000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("completed");

    const stored = harness.traceStore.getById("test", res.execution_id)!;
    const snap = stored.final_context!;
    expect(snap.length).toBeGreaterThan(0);
    expect(snap.some((e) => e.message.role === "system")).toBe(false);
    expect(snap.some((e) => e.message.role === "assistant" && "tool_calls" in e.message)).toBe(
      true,
    );
    const toolEntry = snap.find((e) => e.message.role === "tool");
    expect(toolEntry).toBeDefined();
    expect(toolEntry!.evictable).toBe(true);
    expect(texts(snap).some((t) => t.includes("my-host"))).toBe(true);
    expect(texts(snap)).toContain("The hostname is 'my-host'.");
    expect(stored.capability_state).toBeUndefined();
  });

  it("still captures the context when the run is interrupted (iteration cap)", async () => {
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "/a" } }] },
        { toolCalls: [{ name: "filesystem.read", arguments: { path: "/b" } }] },
      ],
    });
    workspace = mkdtempSync(join(tmpdir(), "clarvis-final-capture-"));
    harness = await makeHarness({ llm, mcpFactory: fsFactory(), workspaceRoot: workspace });

    const res = await harness.run({
      messages: [{ role: "user", content: "Read files" }],
      servers: FS_TOOLS,
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["filesystem.read"],
          iteration_limit: 1,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 100000, timeout_ms: 30000 },
    });
    expect(res.status).toBe("budget_exhausted");

    const stored = harness.traceStore.getById("test", res.execution_id)!;
    const snap = stored.final_context!;
    expect(snap.some((e) => e.message.role === "assistant" && "tool_calls" in e.message)).toBe(
      true,
    );
    expect(snap.some((e) => e.message.role === "tool")).toBe(true);
  });
});
