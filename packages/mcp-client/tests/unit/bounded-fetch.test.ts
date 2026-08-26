import { describe, expect, it } from "bun:test";
import { createMCPBoundedFetch, MCPHttpResponseLimitError } from "../../src/bounded-fetch.ts";

describe("bounded MCP HTTP fetch", () => {
  it("rejects declared oversized bodies without awaiting a stuck cancel", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const fetch = createMCPBoundedFetch({
      maxResponseBytes: 10,
      fetch: async () => new Response(body, { headers: { "content-length": "11" } }),
    });

    await expect(fetch("https://example.test/mcp")).rejects.toBeInstanceOf(
      MCPHttpResponseLimitError,
    );
    expect(cancelled).toBe(true);
  });

  it("errors a streamed response without awaiting a stuck reader cancel", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345678901"));
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    });
    const fetch = createMCPBoundedFetch({
      maxResponseBytes: 10,
      fetch: async () => new Response(body),
    });

    const response = await fetch("https://example.test/mcp");
    await expect(response.text()).rejects.toMatchObject({ limit: "response" });
    expect(cancelled).toBe(true);
  });

  it("bounds one unterminated SSE event and merges configured headers", async () => {
    let resolveAuthorization!: (authorization: string | null) => void;
    const authorization = new Promise<string | null>((resolve) => {
      resolveAuthorization = resolve;
    });
    const fetch = createMCPBoundedFetch({
      headers: { Authorization: "Bearer test" },
      maxResponseBytes: 100,
      maxSseEventBytes: 8,
      fetch: async (_input, init) => {
        resolveAuthorization(new Headers(init?.headers).get("authorization"));
        return new Response("data: 123456789", {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    await expect((await fetch("https://example.test/sse")).text()).rejects.toMatchObject({
      limit: "sse_event",
    });
    expect(await authorization).toBe("Bearer test");
  });

  it("allows a long-lived SSE stream whose individually bounded events exceed the JSON body cap", async () => {
    const fetch = createMCPBoundedFetch({
      maxResponseBytes: 8,
      maxSseEventBytes: 8,
      fetch: async () =>
        new Response("a\n\na\n\na\n\n", {
          headers: { "content-type": "text/event-stream" },
        }),
    });

    await expect((await fetch("https://example.test/sse")).text()).resolves.toBe("a\n\na\n\na\n\n");
  });
});
