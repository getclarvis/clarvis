import { describe, expect, it } from "bun:test";
import type { OpenedConnection } from "@clarvis/mcp-client";
import {
  MAX_MCP_INSTRUCTIONS_SECTION_CHARS,
  createMcpInstructionsRunCapability,
  renderMcpInstructions,
} from "../../src/runtime/mcp-instructions.ts";

function opened(name: string, instructions?: string): OpenedConnection {
  return {
    conn: {
      name,
      transport: "stdio",
      status: "connected",
      ...(instructions === undefined ? {} : { instructions }),
      callTool: async () => ({ ok: true }),
      close: async () => {},
    },
    tools: [],
  };
}

describe("MCP initialize instructions", () => {
  it("renders connected server guidance under the server's exact identity", () => {
    const rendered = renderMcpInstructions([
      opened("docs", "Search before answering."),
      opened("empty", "   "),
      opened("github", "Respect repository rate limits."),
    ]);

    expect(rendered).toContain("### docs\n\nSearch before answering.");
    expect(rendered).toContain("### github\n\nRespect repository rate limits.");
    expect(rendered).not.toContain("### empty");
    expect(rendered).toContain("higher-priority instructions still take precedence");
  });

  it("bounds the aggregate section without splitting Unicode code points", () => {
    const rendered = renderMcpInstructions([opened("large", "🧭".repeat(40_000))]);
    expect(Array.from(rendered ?? "")).toHaveLength(MAX_MCP_INSTRUCTIONS_SECTION_CHARS);
    expect(rendered?.endsWith("\ud83e")).toBe(false);
    expect(rendered).toEndWith("[MCP instructions truncated; remaining guidance omitted.]");
  });

  it("contributes nothing when no connected server supplied instructions", () => {
    expect(renderMcpInstructions([opened("empty")])).toBeUndefined();
    expect(createMcpInstructionsRunCapability([opened("empty")])).toBeUndefined();
  });

  it("exposes a rendered section through a prompt-only run capability", () => {
    const capability = createMcpInstructionsRunCapability([
      opened("docs", "Search before answering."),
    ]);
    expect(capability).toMatchObject({ name: "mcp-instructions" });
    expect(capability?.systemSection?.({ agent: "subagent", entry: true, grants: [] })).toContain(
      "Search before answering.",
    );
    expect(capability?.forAgent({ agent: "subagent", entry: true, grants: [] })).toBeNull();
  });
});
