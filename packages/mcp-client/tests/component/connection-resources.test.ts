import { describe, expect, it } from "bun:test";
import type { McpServerConfig } from "@clarvis/capability";
import { openConnection } from "@clarvis/mcp-client";
import type { MCPClientFactory, MCPClientHandle, OpenedConnection } from "@clarvis/mcp-client";

const SCOPE = { workspace: "/ws", owner: "o" };
const SERVER: McpServerConfig = { name: "docs", transport: "stdio", command: "x" };

interface FakeClientOptions {
  capabilities?: unknown;
  resources?: unknown[];
  resourceTemplates?: unknown[];
  listResources?: () => unknown;
  readResource?: (params: { uri: string }, options: unknown) => unknown;
}

function factoryFor(options: FakeClientOptions): MCPClientFactory {
  return async (): Promise<MCPClientHandle> => ({
    client: {
      listTools: async () => ({
        tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
      }),
      getServerCapabilities: () => options.capabilities,
      listResources: async () =>
        options.listResources?.() ?? { resources: options.resources ?? [] },
      listResourceTemplates: async () => ({
        resourceTemplates: options.resourceTemplates ?? [],
      }),
      readResource: async (params: { uri: string }, requestOptions: unknown) =>
        options.readResource?.(params, requestOptions) ?? {
          contents: [{ uri: params.uri, text: "default" }],
        },
      callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      ping: async () => {},
    } as any,
    close: async () => {},
  });
}

async function open(
  options: FakeClientOptions,
  overrides: Partial<Parameters<typeof openConnection>[0]> = {},
): Promise<OpenedConnection> {
  return openConnection({
    scope: SCOPE,
    server: SERVER,
    connectTimeoutMs: 1_000,
    callTimeoutMs: 250,
    healthPingIntervalMs: 0,
    factory: factoryFor(options),
    ...overrides,
  });
}

describe("openConnection resource composition", () => {
  it("adds the resource façade when the server advertises resources", async () => {
    const opened = await open({
      capabilities: { resources: {} },
      resources: [{ uri: "docs://readme", name: "readme" }],
    });

    expect(opened.tools).toContainEqual(
      expect.objectContaining({ name: "list_resources", kind: "resource_list" }),
    );
    expect(opened.tools).toContainEqual(
      expect.objectContaining({ name: "read_resource", kind: "resource_read" }),
    );
    await opened.conn.close();
  });

  it.each([
    ["missing capability", { capabilities: { tools: {} } }, {}],
    [
      "server opt-out",
      { capabilities: { resources: {} } },
      { server: { ...SERVER, resources: false } },
    ],
    ["host opt-out", { capabilities: { resources: {} } }, { resourcesEnabled: false }],
  ] as const)("omits the resource façade for %s", async (_label, options, overrides) => {
    const opened = await open(options, overrides);
    expect(opened.tools.map((tool) => tool.name)).toEqual(["search"]);
    await opened.conn.close();
  });

  it("keeps the tool connection usable when the resource probe fails", async () => {
    const warnings: unknown[] = [];
    const opened = await open(
      {
        capabilities: { resources: {} },
        listResources: () => {
          throw new Error("resources/list failed");
        },
      },
      {
        logger: {
          debug: () => {},
          info: () => {},
          warn: (...args: unknown[]) => warnings.push(args),
          error: () => {},
        },
      },
    );

    expect(opened.tools.map((tool) => tool.name)).toEqual(["search"]);
    expect(warnings).toHaveLength(1);
    await opened.conn.close();
  });

  it("exposes the probed catalog through listResources", async () => {
    const opened = await open({
      capabilities: { resources: {} },
      resources: [{ uri: "docs://a", name: "a", description: "A" }],
      resourceTemplates: [{ uriTemplate: "docs://{id}", name: "by-id" }],
    });

    const result = await opened.conn.listResources!();
    const text = (result.data as { content: Array<{ text: string }> }).content[0]!.text;
    expect(result.ok).toBe(true);
    expect(text).toContain("docs://a");
    expect(text).toContain("docs://{id}");
    await opened.conn.close();
  });

  it("forwards a representative read through the session and resource mapper", async () => {
    const signal = new AbortController().signal;
    const calls: Array<{ params: unknown; options: unknown }> = [];
    const opened = await open({
      capabilities: { resources: {} },
      readResource: (params, options) => {
        calls.push({ params, options });
        return { contents: [{ uri: params.uri, text: "hello" }] };
      },
    });

    const result = await opened.conn.readResource!("docs://a", signal);
    expect(calls).toEqual([{ params: { uri: "docs://a" }, options: { timeout: 250, signal } }]);
    expect(result).toEqual({
      ok: true,
      data: { content: [{ type: "text", text: "hello" }] },
    });
    await opened.conn.close();
  });
});
