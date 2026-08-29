import { describe, expect, it } from "../bun-test.ts";
import type { McpServerConfig } from "@clarvis/capability";
import type { RegistryEntry } from "../../src/runtime/tools/mcp-registry.ts";
import { addAutomaticMcpTools } from "../../src/runtime/tools/automatic-mcp-tools.ts";
import type { ResolvedSubagentProfile } from "../../src/runtime/subagents/subagent-profiles.ts";

function opened(name: string, tools: string[]): RegistryEntry {
  return {
    conn: { name } as RegistryEntry["conn"],
    tools: tools.map((tool) => ({ name: tool }) as RegistryEntry["tools"][number]),
  };
}

describe("automatic MCP tools", () => {
  it("adds only tools discovered from automatic servers to every resolved profile", () => {
    const servers: McpServerConfig[] = [
      {
        name: "context7:context7",
        transport: "http",
        url: "https://example.test",
        auto_tools: true,
      },
      { name: "private", transport: "stdio", command: "private" },
    ];
    const profiles = [
      { name: "lead", tools: ["private.read"] },
      { name: "worker", tools: [] },
    ] as ResolvedSubagentProfile[];

    expect(
      addAutomaticMcpTools(
        servers,
        [
          opened("context7:context7", ["resolve-library-id", "query-docs"]),
          opened("private", ["read"]),
        ],
        profiles,
      ),
    ).toEqual(["context7:context7.resolve-library-id", "context7:context7.query-docs"]);
    expect(profiles.map((profile) => profile.tools)).toEqual([
      ["private.read", "context7:context7.resolve-library-id", "context7:context7.query-docs"],
      ["context7:context7.resolve-library-id", "context7:context7.query-docs"],
    ]);
  });

  it("does not admit tools from an automatic server that failed to open", () => {
    const profile = { name: "solo", tools: [] } as unknown as ResolvedSubagentProfile;
    const added = addAutomaticMcpTools(
      [{ name: "missing", transport: "stdio", command: "missing", auto_tools: true }],
      [],
      [profile],
    );
    expect(added).toEqual([]);
    expect(profile.tools).toEqual([]);
  });
});
