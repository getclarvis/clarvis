import { describe, expect, it } from "bun:test";
import { MissingEnvVarsError, type McpServerConfig } from "@clarvis/capability";
import { openConnection } from "@clarvis/mcp-client";
import type { MCPClientFactory, MCPClientHandle } from "@clarvis/mcp-client";
import { createRecordingLogger, type RecordingLogger } from "../helpers/recording-logger.ts";

const SCOPE = { workspace: "/ws", owner: "owner" };
const SERVER: McpServerConfig = { name: "docs", transport: "stdio", command: "server" };

interface HandleOptions {
  listTools?: (params: unknown) => unknown;
  capabilities?: unknown;
  listResourceTemplates?: () => unknown;
  identity?: { name: string; version: string } | undefined;
  protocolVersion?: string;
}

function handle(options: HandleOptions = {}): MCPClientHandle {
  return {
    client: {
      listTools: async (params: unknown) =>
        options.listTools?.(params) ?? {
          tools: [{ name: "search", description: "Search", inputSchema: { type: "object" } }],
        },
      getServerCapabilities: () => options.capabilities,
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () =>
        options.listResourceTemplates?.() ?? { resourceTemplates: [] },
      callTool: async () => ({ content: [] }),
      ping: async () => {},
      ...(options.identity === undefined ? {} : { getServerVersion: () => options.identity }),
    } as any,
    close: async () => {},
    ...(options.protocolVersion !== undefined ? { protocolVersion: options.protocolVersion } : {}),
  };
}

function open(
  factory: MCPClientFactory,
  recording: RecordingLogger,
  overrides: Partial<Parameters<typeof openConnection>[0]> = {},
): ReturnType<typeof openConnection> {
  return openConnection({
    scope: SCOPE,
    server: SERVER,
    connectTimeoutMs: 1_000,
    callTimeoutMs: 250,
    healthPingIntervalMs: 0,
    resourcesEnabled: false,
    logger: recording.logger,
    factory,
    ...overrides,
  });
}

describe("openConnection observability", () => {
  it("binds the connection's identity and reports a successful handshake", async () => {
    const recording = createRecordingLogger();
    const opened = await open(
      async () =>
        handle({
          identity: { name: "docs-server", version: "2.3.1" },
          protocolVersion: "2025-06-18",
        }),
      recording,
    );

    const begin = recording.first("mcp.connect.begin");
    expect(begin?.level).toBe("debug");
    expect(begin?.fields).toMatchObject({ connect_timeout_ms: 1_000, attempt: 1 });
    const ok = recording.first("mcp.connect.ok");
    expect(ok?.level).toBe("info");
    expect(ok?.fields).toMatchObject({
      workspace: "/ws",
      owner: "owner",
      mcp: "docs",
      transport: "stdio",
      server_name: "docs-server",
      server_version: "2.3.1",
      protocol_version: "2025-06-18",
    });
    expect(typeof ok?.fields.duration_ms).toBe("number");
    expect(recording.records.some((record) => "run_id" in record.fields)).toBe(false);
    await opened.conn.close();
  });

  it("omits an identity a substituted factory does not report", async () => {
    const recording = createRecordingLogger();
    const opened = await open(async () => handle(), recording);

    const ok = recording.first("mcp.connect.ok");
    expect(ok?.fields.server_name).toBeUndefined();
    expect(ok?.fields.protocol_version).toBeUndefined();
    await opened.conn.close();
  });

  it("names the unresolved variables of a ${VAR} interpolation failure, and no values", async () => {
    const recording = createRecordingLogger();
    await expect(
      open(() => Promise.reject(new MissingEnvVarsError(["DOCS_TOKEN", "DOCS_URL"])), recording),
    ).rejects.toThrow("unresolved environment variable");

    const failed = recording.first("mcp.connect.failed");
    expect(failed?.level).toBe("warn");
    expect(failed?.fields.missing_env).toEqual(["DOCS_TOKEN", "DOCS_URL"]);
    expect(failed?.fields.reason).toContain("DOCS_TOKEN");
  });

  it("reports an ordinary connect failure without a missing-variable list", async () => {
    const recording = createRecordingLogger();
    await expect(open(() => Promise.reject(new Error("spawn failed")), recording)).rejects.toThrow(
      "spawn failed",
    );

    const failed = recording.first("mcp.connect.failed");
    expect(failed?.fields.missing_env).toBeUndefined();
    expect(failed?.fields.reason).toContain("spawn failed");
  });

  it("counts a reconnect as the next attempt on the same bound logger", async () => {
    const recording = createRecordingLogger();
    let connects = 0;
    const opened = await open(async () => {
      connects += 1;
      const built = handle({ listTools: () => ({ tools: [] }) });
      if (connects === 1) {
        (built.client as unknown as { callTool: () => Promise<never> }).callTool = () =>
          Promise.reject(new Error("transport gone"));
      }
      return built;
    }, recording);

    await opened.conn.callTool("search", {});

    expect(connects).toBe(2);
    expect(recording.all("mcp.connect.begin").map((record) => record.fields.attempt)).toEqual([
      1, 2,
    ]);
    expect(recording.all("mcp.connect.ok")).toHaveLength(2);
    await opened.conn.close();
  });

  it("lists the tool catalog once, with names only at debug", async () => {
    const recording = createRecordingLogger();
    const opened = await open(
      async () =>
        handle({
          listTools: () => ({
            tools: [
              { name: "search", inputSchema: { type: "object" } },
              { name: "fetch", inputSchema: { type: "object" } },
            ],
          }),
        }),
      recording,
    );

    const listed = recording.first("mcp.tools.listed");
    expect(listed?.level).toBe("info");
    expect(listed?.fields).toMatchObject({ count: 2, pages: 1, truncated: false });
    expect(listed?.fields.bytes).toBeGreaterThan(0);
    expect(listed?.fields.names).toEqual(["search", "fetch"]);
    await opened.conn.close();
  });

  it("withholds the tool names when the logger is above debug", async () => {
    const recording = createRecordingLogger("info");
    const opened = await open(async () => handle(), recording);

    expect(recording.first("mcp.tools.listed")?.fields.names).toBeUndefined();
    await opened.conn.close();
  });

  it("reports which discovery bound a runaway tool catalog crossed", async () => {
    const cases: Array<{ kind: string; overrides: Record<string, number> }> = [
      { kind: "entries", overrides: { maxToolCatalogEntries: 1 } },
      { kind: "bytes", overrides: { maxToolCatalogBytes: 1 } },
    ];
    for (const testCase of cases) {
      const recording = createRecordingLogger();
      await expect(
        open(
          async () =>
            handle({
              listTools: () => ({
                tools: [
                  { name: "a", inputSchema: { type: "object" } },
                  { name: "b", inputSchema: { type: "object" } },
                ],
              }),
            }),
          recording,
          testCase.overrides,
        ),
      ).rejects.toThrow("Failed to list tools");
      const limit = recording.first("mcp.catalog.limit");
      expect(limit?.level).toBe("warn");
      expect(limit?.fields.kind).toBe(testCase.kind);
      expect(limit?.fields.observed).toBeGreaterThan(0);
    }
  });

  it("reports the page bound of a server that never stops paginating", async () => {
    const recording = createRecordingLogger();
    let page = 0;
    await expect(
      open(
        async () =>
          handle({
            listTools: () => {
              page += 1;
              return { tools: [], nextCursor: `page-${String(page)}` };
            },
          }),
        recording,
      ),
    ).rejects.toThrow("page limit");

    expect(recording.first("mcp.catalog.limit")?.fields).toMatchObject({ kind: "pages" });
  });

  it("reports a template listing that failed, and keeps the concrete resources", async () => {
    const recording = createRecordingLogger();
    const opened = await open(
      async () =>
        handle({
          capabilities: { resources: {} },
          listResourceTemplates: () => {
            throw new Error("templates unsupported");
          },
        }),
      recording,
      { resourcesEnabled: true },
    );

    const failed = recording.first("mcp.resources.templates_failed");
    expect(failed?.level).toBe("debug");
    expect(failed?.fields.reason).toContain("templates unsupported");
    expect(opened.tools.some((tool) => tool.name === "list_resources")).toBe(true);
    await opened.conn.close();
  });

  it("reports a resource probe that failed outright", async () => {
    const recording = createRecordingLogger();
    const opened = await open(
      async () => {
        const built = handle({ capabilities: { resources: {} } });
        (built.client as unknown as { listResources: () => Promise<never> }).listResources = () =>
          Promise.reject(new Error("resources exploded"));
        return built;
      },
      recording,
      { resourcesEnabled: true },
    );

    const probe = recording.first("mcp.resources.probe_failed");
    expect(probe?.level).toBe("warn");
    expect(probe?.fields.reason).toContain("resources exploded");
    expect(opened.tools.some((tool) => tool.name === "list_resources")).toBe(false);
    await opened.conn.close();
  });
});
