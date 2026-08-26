import type { MCPClientFactory, MCPClientHandle } from "@clarvis/mcp-client";
import type { McpServerConfig } from "@clarvis/capability";

/**
 * A scripted MCP tool exposed by a mock server.
 *
 * @remarks `call` may return any value (wrapped as text content) or throw; a
 *   throw is surfaced as an `isError` tool result rather than a rejected
 *   promise. An omitted `inputSchema` defaults to an empty object schema.
 */
export interface MockMCPTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  call: (args: unknown) => unknown;
}

/**
 * A scripted MCP resource served by a mock server.
 *
 * @remarks On read, a defined `blob` is returned as binary content; otherwise
 *   `text` (defaulting to `""`) is returned. Presence of `resources` on the
 *   options also gates the server's advertised resource capability.
 */
export interface MockMCPResource {
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
  text?: string;
  blob?: string;
}

/**
 * Per-server configuration for {@link mockMCPFactory}: the tools and resources
 * to serve plus injectable failure/latency hooks.
 *
 * @remarks `connectDelayMs` delays connection, `connectError` fails it,
 *   `listToolsError` fails only `listTools`; all model transport faults for
 *   tests.
 */
export interface MockMCPOptions {
  tools: MockMCPTool[];
  listToolsError?: Error;
  connectError?: Error;
  connectDelayMs?: number;
  resources?: MockMCPResource[];
}

/**
 * MCPClientFactory double serving per-server scripted tools/resources. Shared
 * through `./testing` so downstream suites reuse the same MCP wire behavior.
 *
 * @param byName - mock configurations keyed by MCP server name; connecting to a
 *   server absent from this map throws.
 * @returns a factory that, per {@link McpServerConfig}, yields a client handle
 *   honoring the server's scripted tools, resources, and injected
 *   connect/list faults; once closed, `callTool` and `readResource` reject.
 */
export function mockMCPFactory(byName: Record<string, MockMCPOptions>): MCPClientFactory {
  return async (tool: McpServerConfig): Promise<MCPClientHandle> => {
    const opts = byName[tool.name];
    if (!opts) {
      throw new Error(`No mock MCP configured for tool '${tool.name}'`);
    }
    if (opts.connectDelayMs) await new Promise((r) => setTimeout(r, opts.connectDelayMs));
    if (opts.connectError) throw opts.connectError;
    let closed = false;
    const client = {
      listTools(): Promise<{
        tools: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
      }> {
        if (opts.listToolsError) return Promise.reject(opts.listToolsError);
        return Promise.resolve({
          tools: opts.tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
          })),
        });
      },
      async callTool({
        name,
        arguments: args,
      }: {
        name: string;
        arguments: unknown;
      }): Promise<unknown> {
        if (closed) throw new Error(`MCP '${tool.name}' is closed`);
        const t = opts.tools.find((x) => x.name === name);
        if (!t) throw new Error(`Tool '${name}' not found`);
        try {
          const data = await t.call(args);
          return {
            content: [
              { type: "text", text: typeof data === "string" ? data : JSON.stringify(data) },
            ],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          };
        }
      },
      getServerCapabilities(): { resources?: Record<string, never> } | undefined {
        return opts.resources ? { resources: {} } : undefined;
      },
      listResources(): Promise<{
        resources: { uri: string; name: string; mimeType?: string; description?: string }[];
      }> {
        return Promise.resolve({
          resources: (opts.resources ?? []).map((r) => ({
            uri: r.uri,
            name: r.name,
            ...(r.mimeType !== undefined ? { mimeType: r.mimeType } : {}),
            ...(r.description !== undefined ? { description: r.description } : {}),
          })),
        });
      },
      listResourceTemplates(): Promise<{ resourceTemplates: never[] }> {
        return Promise.resolve({ resourceTemplates: [] });
      },
      readResource({ uri }: { uri: string }): Promise<{ contents: unknown[] }> {
        if (closed) return Promise.reject(new Error(`MCP '${tool.name}' is closed`));
        const r = (opts.resources ?? []).find((x) => x.uri === uri);
        if (!r) return Promise.reject(new Error(`Resource '${uri}' not found`));
        const entry: Record<string, unknown> = { uri: r.uri };
        if (r.mimeType !== undefined) entry.mimeType = r.mimeType;
        if (r.blob !== undefined) entry.blob = r.blob;
        else entry.text = r.text ?? "";
        return Promise.resolve({ contents: [entry] });
      },
      close(): Promise<void> {
        closed = true;
        return Promise.resolve();
      },
    };
    return {
      client: client as unknown as MCPClientHandle["client"],
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };
  };
}
