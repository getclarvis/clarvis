import { describe, expect, it } from "bun:test";
import type { MCPConnection } from "@clarvis/capability";
import { BunStdioClientTransport } from "../../src/bun-stdio-client.ts";
import { createMCPBoundedFetch } from "../../src/bounded-fetch.ts";
import { buildRegistry, toWireToolName } from "../../src/registry.ts";
import { paginate } from "../../src/resources.ts";
import { createRecordingLogger } from "../helpers/recording-logger.ts";

interface PrivateStreamReaders {
  readMessages(stream: ReadableStream<Uint8Array>): Promise<void>;
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function connection(name: string): MCPConnection {
  return {
    name,
    transport: "stdio",
    status: "connected",
    callTool: async () => ({ ok: true, data: {} }),
    listResources: async () => ({ ok: true, data: {} }),
    readResource: async () => ({ ok: true, data: {} }),
    close: async () => {},
  };
}

describe("transport limit observability", () => {
  it("reports a refused stdio frame at error level", async () => {
    const recording = createRecordingLogger();
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      maxFrameBytes: 8,
      logger: recording.logger,
    });
    transport.onerror = () => {};

    await (transport as unknown as PrivateStreamReaders).readMessages(
      streamOf(new TextEncoder().encode("12345"), new TextEncoder().encode("6789")),
    );

    const refused = recording.first("mcp.transport.frame_limit");
    expect(refused?.level).toBe("error");
    expect(refused?.fields).toMatchObject({ limit: 8, observed: 9 });
  });

  it("refuses a frame silently when no logger was supplied", async () => {
    const transport = new BunStdioClientTransport({
      command: "unused-in-test",
      maxFrameBytes: 8,
    });
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);

    await (transport as unknown as PrivateStreamReaders).readMessages(
      streamOf(new TextEncoder().encode("123456789")),
    );

    expect(errors[0]).toMatchObject({ code: "mcp_stdio_frame_too_large" });
  });

  it("reports a declared oversized body, naming the server", async () => {
    const recording = createRecordingLogger();
    const fetch = createMCPBoundedFetch({
      maxResponseBytes: 10,
      logger: recording.logger,
      mcpName: "docs",
      fetch: async () =>
        new Response(new ReadableStream<Uint8Array>(), { headers: { "content-length": "11" } }),
    });

    await expect(fetch("https://example.test/mcp")).rejects.toMatchObject({ limit: "response" });

    const refused = recording.first("mcp.transport.response_limit");
    expect(refused?.level).toBe("error");
    expect(refused?.fields).toMatchObject({ mcp: "docs", kind: "response", limit: 10 });
  });

  it("reports a streamed body and an unterminated SSE event by kind", async () => {
    const recording = createRecordingLogger();
    const streamed = createMCPBoundedFetch({
      maxResponseBytes: 10,
      logger: recording.logger,
      mcpName: "docs",
      fetch: async () => new Response("12345678901"),
    });
    await expect((await streamed("https://example.test/mcp")).text()).rejects.toMatchObject({
      limit: "response",
    });

    const sse = createMCPBoundedFetch({
      maxResponseBytes: 100,
      maxSseEventBytes: 8,
      logger: recording.logger,
      mcpName: "docs",
      fetch: async () =>
        new Response("data: 123456789", { headers: { "content-type": "text/event-stream" } }),
    });
    await expect((await sse("https://example.test/sse")).text()).rejects.toMatchObject({
      limit: "sse_event",
    });

    expect(recording.all("mcp.transport.response_limit").map((r) => r.fields.kind)).toEqual([
      "response",
      "sse_event",
    ]);
  });

  it("omits the server name when the bounded fetch was given none", async () => {
    const recording = createRecordingLogger();
    const fetch = createMCPBoundedFetch({
      maxResponseBytes: 10,
      logger: recording.logger,
      fetch: async () => new Response("12345678901"),
    });

    await expect((await fetch("https://example.test/mcp")).text()).rejects.toMatchObject({
      limit: "response",
    });
    expect(recording.first("mcp.transport.response_limit")?.fields.mcp).toBeUndefined();
  });
});

describe("resource catalog limit observability", () => {
  it("names the bound a resource listing crossed", async () => {
    const recording = createRecordingLogger();

    await expect(
      paginate(async () => ({ items: [1, 2, 3] }), {
        maxItems: 1,
        maxBytes: 1_000,
        logger: recording.logger,
      }),
    ).rejects.toMatchObject({ dimension: "entries" });

    await expect(
      paginate(async () => ({ items: ["aaaaaaaaaa"] }), {
        maxItems: 10,
        maxBytes: 1,
        logger: recording.logger,
      }),
    ).rejects.toMatchObject({ dimension: "bytes" });

    let page = 0;
    await expect(
      paginate(
        async () => {
          page += 1;
          return { items: [], nextCursor: `page-${String(page)}` };
        },
        { maxItems: 10, maxBytes: 1_000, logger: recording.logger },
      ),
    ).rejects.toMatchObject({ dimension: "pages" });

    expect(recording.all("mcp.catalog.limit").map((record) => record.fields.kind)).toEqual([
      "entries",
      "bytes",
      "pages",
    ]);
    expect(recording.all("mcp.catalog.limit").every((record) => record.level === "warn")).toBe(
      true,
    );
  });

  it("stays silent when no logger reaches the paginator", async () => {
    await expect(
      paginate(async () => ({ items: [1, 2] }), { maxItems: 1, maxBytes: 100 }),
    ).rejects.toMatchObject({ dimension: "entries" });
  });
});

describe("registry rename observability", () => {
  it("reports a tool renamed because a reserved host name took its place", () => {
    const recording = createRecordingLogger();
    buildRegistry(
      [{ conn: connection("fs"), tools: [{ name: "file", inputSchema: {} }] }],
      ["fs_file"],
      { logger: recording.logger },
    );

    const renamed = recording.first("mcp.registry.renamed");
    expect(renamed?.level).toBe("warn");
    expect(renamed?.fields).toMatchObject({
      mcp: "fs",
      tool: "file",
      full_name: "fs.file",
      wire_name: "fs_file_1",
      reason: "reserved",
    });
  });

  it("reports a tool renamed because another server already took the name", () => {
    const recording = createRecordingLogger();
    buildRegistry(
      [
        { conn: connection("docs"), tools: [{ name: "a.b", inputSchema: {} }] },
        { conn: connection("docs"), tools: [{ name: "a_b", inputSchema: {} }] },
      ],
      [],
      { logger: recording.logger },
    );

    expect(recording.first("mcp.registry.renamed")?.fields).toMatchObject({
      wire_name: "docs_a_b_1",
      reason: "collision",
    });
  });

  it("says nothing when no name had to change, and needs no logger", () => {
    const recording = createRecordingLogger();
    buildRegistry(
      [{ conn: connection("docs"), tools: [{ name: "search", inputSchema: {} }] }],
      ["read_file"],
      { logger: recording.logger },
    );
    expect(recording.all("mcp.registry.renamed")).toHaveLength(0);

    const used = new Set<string>(["docs_search"]);
    expect(toWireToolName("docs.search", used)).toBe("docs_search_1");
    expect(buildRegistry([], []).tools).toEqual([]);
  });
});
