import { describe, expect, it } from "../helpers/bun-test.ts";
import { createBoundedFetch, ProviderResponseLimitError } from "../../src/ai-sdk/bounded-fetch.ts";

function fetchOf(response: Response): typeof globalThis.fetch {
  return (async () => response) as unknown as typeof globalThis.fetch;
}

describe("bounded provider fetch", () => {
  it("rejects an oversized declared response before reading it", async () => {
    const fetch = createBoundedFetch({
      fetch: fetchOf(new Response("x", { headers: { "content-length": "11" } })),
      maxResponseBytes: 10,
    });
    await expect(fetch("https://example.test")).rejects.toMatchObject({
      name: "ProviderResponseLimitError",
      limit: "response",
    });
  });

  it("does not wait for a declared response body's cancel algorithm", async () => {
    let cancelStarted = false;
    let rejectCancel!: (reason: unknown) => void;
    const cancellation = new Promise<void>((_resolve, reject) => {
      rejectCancel = reject;
    });
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelStarted = true;
        return cancellation;
      },
    });
    const fetch = createBoundedFetch({
      fetch: fetchOf(new Response(body, { headers: { "content-length": "11" } })),
      maxResponseBytes: 10,
    });

    await expect(fetch("https://example.test")).rejects.toBeInstanceOf(ProviderResponseLimitError);
    expect(cancelStarted).toBe(true);

    rejectCancel(new Error("late body cancel failure"));
    await Bun.sleep(0);
  });

  it("bounds streamed bytes even without content-length", async () => {
    const fetch = createBoundedFetch({
      fetch: fetchOf(new Response("12345678901")),
      maxResponseBytes: 10,
      maxSseEventBytes: 100,
    });
    const response = await fetch("https://example.test");
    await expect(response.text()).rejects.toBeInstanceOf(ProviderResponseLimitError);
  });

  it("surfaces a streamed limit without waiting for reader cancellation", async () => {
    let cancelStarted = false;
    let rejectCancel!: (reason: unknown) => void;
    const cancellation = new Promise<void>((_resolve, reject) => {
      rejectCancel = reject;
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("12345678901"));
      },
      cancel() {
        cancelStarted = true;
        return cancellation;
      },
    });
    const fetch = createBoundedFetch({
      fetch: fetchOf(new Response(body)),
      maxResponseBytes: 10,
    });

    await expect((await fetch("https://example.test")).text()).rejects.toBeInstanceOf(
      ProviderResponseLimitError,
    );
    expect(cancelStarted).toBe(true);

    rejectCancel(new Error("late reader cancel failure"));
    await Bun.sleep(0);
  });

  it("recognises SSE delimiters split across source chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: 12\r\n"));
        controller.enqueue(new TextEncoder().encode("\r\ndata: 34\n"));
        controller.enqueue(new TextEncoder().encode("\n"));
        controller.close();
      },
    });
    const fetch = createBoundedFetch({
      fetch: fetchOf(new Response(body, { headers: { "content-type": "text/event-stream" } })),
      maxResponseBytes: 100,
      maxSseEventBytes: 12,
    });
    await expect((await fetch("https://example.test")).text()).resolves.toContain("data: 34");
  });

  it("rejects one unterminated SSE event while the total response is still small", async () => {
    const fetch = createBoundedFetch({
      fetch: fetchOf(
        new Response("data: 123456789", { headers: { "content-type": "text/event-stream" } }),
      ),
      maxResponseBytes: 100,
      maxSseEventBytes: 8,
    });
    await expect((await fetch("https://example.test")).text()).rejects.toMatchObject({
      limit: "sse_event",
    });
  });

  it("aborts upstream when the consumer cancels the bounded body", async () => {
    // A caller that walks away mid-stream must not leave the provider request
    // running: cancelling the body is what tells the upstream to stop, and the
    // reader is released rather than left holding the connection.
    let upstreamAborted = false;
    let sourceCancelled: unknown;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial"));
      },
      cancel(reason) {
        sourceCancelled = reason;
      },
    });
    const fetch = createBoundedFetch({
      fetch: (async (_input: unknown, init?: { signal?: AbortSignal }) => {
        init?.signal?.addEventListener("abort", () => {
          upstreamAborted = true;
        });
        return new Response(body);
      }) as unknown as typeof globalThis.fetch,
      maxResponseBytes: 1024,
    });

    const response = await fetch("https://example.test");
    const reader = response.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel(new Error("caller walked away"));
    await Bun.sleep(0);

    expect(upstreamAborted).toBe(true);
    expect(sourceCancelled).toBeInstanceOf(Error);
  });
});
