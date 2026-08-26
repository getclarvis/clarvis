import { describe, it, expect, afterEach } from "../bun-test.ts";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { workspaceStatePaths } from "@clarvis/paths";
import { MockLLM, mockMCPFactory } from "./_fixtures.ts";
import { makeHarness, type TestHarness } from "./_helpers.ts";

let harness: TestHarness | null = null;
afterEach(async () => {
  await harness?.close();
  harness = null;
});

describe("a Subagent survives a tool result larger than its window", () => {
  it("truncates the live copy with a marker; the run continues; the full result stays in the trace", async () => {
    const BIG = "DDDD ".repeat(1600);
    const llm = new MockLLM({
      script: [
        { toolCalls: [{ name: "docs.fetch", arguments: { id: "x" } }] },
        { text: "summarized" },
      ],
    });
    const mcp = mockMCPFactory({ docs: { tools: [{ name: "fetch", call: () => BIG }] } });

    const workspaceRoot = await mkdtemp(path.join(tmpdir(), "clarvis-truncate-"));
    harness = await makeHarness({
      llm,
      mcpFactory: mcp,
      workspaceRoot,
      env: { CLARVIS_DEFAULT_COMPACTION_MAX_RESULT_CHARS: "100" },
    });

    const res = await harness.run({
      messages: [{ role: "user", content: "fetch and summarize" }],
      servers: [{ name: "docs", transport: "stdio", command: "mock-server" }],
      profiles: [
        {
          name: "solo",
          model: "anthropic/claude-sonnet-4-5",
          tools: ["docs.fetch"],
          iteration_limit: 5,
        },
      ],
      entry: "solo",
      budget: { on_exceed: "stop", total_token_limit: 50000 },
    });

    const body = res as unknown as { status: string; execution_id: string };
    expect(body.status).toBe("completed");

    const seen = JSON.stringify(llm.calls[1]!.messages);
    expect(seen).toContain("[runtime: tool result truncated");
    expect(seen).not.toContain(BIG);

    const stored = harness.traceStore.getById("test", body.execution_id);
    const compaction = stored!.trace.events.filter((e) => e.type === "compaction");
    expect(compaction).toHaveLength(1);
    const ev = compaction[0] as {
      operation: string;
      agent: string;
      original_chars: number;
      kept_chars: number;
      subagent_instance_id?: string;
    };
    expect(ev.operation).toBe("truncation");
    expect(ev.agent).toBe("subagent");
    expect(typeof ev.subagent_instance_id).toBe("string");
    expect(ev.original_chars).toBeGreaterThan(5000);
    expect(ev.kept_chars).toBe(100);

    const localDir = workspaceStatePaths(workspaceRoot).localDir;
    const spills = (await readdir(localDir)).filter((n) => n.startsWith("toolout-"));
    expect(spills).toHaveLength(1);
    const spillPath = path.join(localDir, spills[0]!);
    expect(spillPath.startsWith(workspaceRoot)).toBe(false);
    expect(seen).toContain(`full output at ${spillPath}`);
    const spilled = await readFile(spillPath, "utf8");
    expect(spilled).toContain(BIG);
    expect(spilled.length).toBe(ev.original_chars);

    const toolCall = stored!.trace.events.find((e) => e.type === "tool_call") as { result: string };
    expect(toolCall.result).toContain("...[truncated]");
    expect(toolCall.result.length).toBeLessThan(ev.original_chars);
    expect(toolCall.result).toContain("DDDD");
  });
});
