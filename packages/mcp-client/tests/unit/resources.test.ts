import { describe, expect, it } from "bun:test";
import type { MCPClientHandle } from "../../src/client.ts";
import {
  appendResourceDescriptors,
  catalogResult,
  loadResourceCatalog,
  MCPResourceCatalogLimitError,
  paginate,
  resourceContentsToBlocks,
  resourceReadResult,
} from "../../src/resources.ts";

function handle(client: Record<string, unknown>): MCPClientHandle {
  return { client: client as any, close: async () => {} };
}

describe("resource catalog policy", () => {
  it("adds both synthetic descriptors without shadowing real tool names", () => {
    const tools = [{ name: "read_resource", inputSchema: {} }];
    appendResourceDescriptors(tools);

    expect(tools.filter((tool) => tool.name === "read_resource")).toHaveLength(1);
    expect(tools).toContainEqual(
      expect.objectContaining({ name: "list_resources", kind: "resource_list" }),
    );
    expect(tools.find((tool) => tool.name === "list_resources")?.inputSchema).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
  });

  it("follows cursors until exhaustion", async () => {
    const seen: Array<string | undefined> = [];
    const items = await paginate(async (cursor) => {
      seen.push(cursor);
      if (!cursor) return { items: [1], nextCursor: "p2" };
      if (cursor === "p2") return { items: [2], nextCursor: "p3" };
      return { items: [3] };
    });

    expect(items).toEqual([1, 2, 3]);
    expect(seen).toEqual([undefined, "p2", "p3"]);
  });

  it("stops on a repeated cursor and rejects a hostile catalog after 50 pages", async () => {
    let repeatedCalls = 0;
    const repeated = await paginate(async () => {
      repeatedCalls += 1;
      return { items: [repeatedCalls], nextCursor: "stuck" };
    });
    expect(repeated).toEqual([1, 2]);

    let cappedCalls = 0;
    await expect(
      paginate(async () => ({
        items: [++cappedCalls],
        nextCursor: `p${cappedCalls}`,
      })),
    ).rejects.toMatchObject({ dimension: "pages", limit: 50 });
    expect(cappedCalls).toBe(50);
  });

  it("fails before retaining a catalog beyond its entry or byte budget", async () => {
    await expect(
      paginate(async () => ({ items: [1, 2, 3] }), { maxItems: 2, maxBytes: 100 }),
    ).rejects.toBeInstanceOf(MCPResourceCatalogLimitError);
    await expect(
      paginate(async () => ({ items: ["x".repeat(20)] }), { maxItems: 10, maxBytes: 8 }),
    ).rejects.toMatchObject({ dimension: "bytes", limit: 8 });
  });

  it("hard-caps non-finite programmatic catalog limits", async () => {
    const oversized = Array.from({ length: 5_001 }, (_, index) => index);
    await expect(
      paginate(async () => ({ items: oversized }), {
        maxItems: Number.POSITIVE_INFINITY,
        maxBytes: Number.NaN,
      }),
    ).rejects.toMatchObject({ dimension: "entries", limit: 5_000 });
  });

  it("returns null without a resource capability", async () => {
    const catalog = await loadResourceCatalog(
      handle({ getServerCapabilities: () => ({ tools: {} }) }),
      100,
    );
    expect(catalog).toBeNull();
  });

  it("loads full and minimal resources/templates and forwards timeout and signal", async () => {
    const signal = new AbortController().signal;
    const seenOptions: unknown[] = [];
    const catalog = await loadResourceCatalog(
      handle({
        getServerCapabilities: () => ({ resources: {} }),
        listResources: async (_params: unknown, options: unknown) => {
          seenOptions.push(options);
          return {
            resources: [
              { uri: "docs://a", name: "a", description: "A", mimeType: "text/plain" },
              { uri: "docs://b", name: "b" },
            ],
          };
        },
        listResourceTemplates: async (_params: unknown, options: unknown) => {
          seenOptions.push(options);
          return {
            resourceTemplates: [
              {
                uriTemplate: "docs://{id}",
                name: "by-id",
                description: "By id",
                mimeType: "text/plain",
              },
              { uriTemplate: "docs://{slug}", name: "by-slug" },
            ],
          };
        },
      }),
      123,
      signal,
    );

    expect(catalog).toEqual({
      resources: [
        { uri: "docs://a", name: "a", description: "A", mimeType: "text/plain" },
        { uri: "docs://b", name: "b" },
      ],
      resourceTemplates: [
        {
          uriTemplate: "docs://{id}",
          name: "by-id",
          description: "By id",
          mimeType: "text/plain",
        },
        { uriTemplate: "docs://{slug}", name: "by-slug" },
      ],
    });
    expect(seenOptions).toEqual([
      { timeout: 123, signal },
      { timeout: 123, signal },
    ]);
  });

  it("treats resource templates as optional", async () => {
    const catalog = await loadResourceCatalog(
      handle({
        getServerCapabilities: () => ({ resources: {} }),
        listResources: async () => ({ resources: [{ uri: "x://1", name: "one" }] }),
        listResourceTemplates: async () => {
          throw new Error("method not found");
        },
      }),
      100,
    );

    expect(catalog).toEqual({
      resources: [{ uri: "x://1", name: "one" }],
      resourceTemplates: [],
    });
  });

  it("renders an empty or populated catalog as a text result", () => {
    expect(catalogResult(null)).toEqual({
      ok: true,
      data: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ resources: [], resourceTemplates: [] }, null, 2),
          },
        ],
      },
    });

    const result = catalogResult({
      resources: [{ uri: "x://1", name: "one" }],
      resourceTemplates: [],
    });
    expect((result.data as { content: Array<{ text: string }> }).content[0]!.text).toContain(
      '"uri": "x://1"',
    );
  });
});

describe("resource content policy", () => {
  it("returns text inline and preserves all readable entries", () => {
    expect(
      resourceContentsToBlocks(
        [null, 42, { uri: "x://a", text: "first" }, { text: "second" }],
        "x://requested",
      ),
    ).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("maps a bounded image blob to an image block", () => {
    const image = Buffer.from("image").toString("base64");
    expect(resourceContentsToBlocks([{ blob: image, mimeType: "image/png" }], "x://i")).toEqual([
      { type: "image", data: image, mimeType: "image/png" },
    ]);
  });

  it("summarizes non-image binary without exposing base64", () => {
    const binary = Buffer.from("PDFBYTES").toString("base64");
    const block = resourceContentsToBlocks(
      [{ uri: "x://pdf", blob: binary, mimeType: "application/pdf" }],
      "x://requested",
    )[0]!;
    expect(block.text).toContain("binary resource application/pdf, 8 bytes");
    expect(block.text).toContain("uri=x://pdf");
    expect(block.text).not.toContain(binary);
  });

  it("uses octet-stream and the requested URI for a mime-less blob", () => {
    const binary = Buffer.from("RAW").toString("base64");
    expect(resourceContentsToBlocks([{ blob: binary }], "x://requested")[0]!.text).toContain(
      "binary resource application/octet-stream, 3 bytes — not inlined; uri=x://requested",
    );
  });

  it("refuses an oversized image with the cap-specific note", () => {
    const block = resourceContentsToBlocks(
      [{ uri: "x://big", blob: "A".repeat(3_000_000), mimeType: "image/png" }],
      "x://requested",
    )[0]!;
    expect(block.text).toContain("image resource image/png");
    expect(block.text).toContain("exceeds the 2000000-byte inline cap");
    expect(block.text).toContain("uri=x://big");
  });

  it("truncates oversized ASCII text at the byte cap", () => {
    const big = "a".repeat(2_500_000);
    const text = resourceContentsToBlocks([{ text: big }], "x://text")[0]!.text!;
    const body = text.split("\n\n[resource truncated")[0]!;
    expect(Buffer.byteLength(body, "utf8")).toBe(2_000_000);
    expect(text).toContain("[resource truncated at 2000000 bytes]");
  });

  it("truncates oversized multibyte text on a UTF-8 character boundary", () => {
    const text = resourceContentsToBlocks([{ text: "中".repeat(700_000) }], "x://text")[0]!.text!;
    const body = text.split("\n\n[resource truncated")[0]!;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(2_000_000);
    expect(body).not.toContain("�");
  });

  it("distinguishes empty content from unreadable content", () => {
    expect(resourceContentsToBlocks([], "x://empty")).toEqual([
      { type: "text", text: "Resource 'x://empty' returned no content." },
    ]);
    expect(resourceContentsToBlocks([null, 42, {}], "x://bad")).toEqual([
      { type: "text", text: "Resource 'x://bad' returned no readable content." },
    ]);
  });

  it("wraps converted content in a successful read result", () => {
    expect(resourceReadResult({ contents: [{ text: "hello" }] }, "x://hello")).toEqual({
      ok: true,
      data: { content: [{ type: "text", text: "hello" }] },
    });
  });
});
