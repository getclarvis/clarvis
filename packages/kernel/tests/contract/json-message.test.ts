import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "bun:test";
import { createJsonMessageWriter, JsonMessageDecoder } from "../../src/core/json-message.ts";

describe("bounded logical JSON transfer", () => {
  it("preserves Unicode across fragments and serializes complete messages without interleaving", async () => {
    const output = new PassThrough();
    const values: unknown[] = [];
    const lengths: number[] = [];
    const decoder = new JsonMessageDecoder(() => {
      throw new Error("unexpected timeout");
    });
    output.on("data", (chunk: Buffer) => {
      lengths.push(chunk.length);
      const message = decoder.accept(JSON.parse(chunk.toString()), chunk.length);
      if (message !== undefined) values.push(message.value);
    });
    const writer = createJsonMessageWriter({
      output,
      frameBytes: 512 * 1024,
      queueMessages: 4,
      onFailure: () => {
        throw new Error("unexpected write failure");
      },
    });
    const body = "🙂á".repeat(300_000);
    try {
      await Promise.all([writer.send({ body }), writer.send({ next: true })]);
      expect(values).toEqual([{ body }, { next: true }]);
      expect(lengths.length).toBeGreaterThan(2);
      expect(lengths.every((length) => length <= 512 * 1024)).toBe(true);
    } finally {
      writer.close();
      decoder.close();
      output.destroy();
    }
  });

  it.each(["offset", "size", "base64", "shape", "interleave"])(
    "refuses %s violations while assembling",
    (kind) => {
      const decoder = new JsonMessageDecoder(() => {});
      const data = Buffer.alloc(256 * 1024).toString("base64");
      const fragment = { $clarvis_message: { offset: 0, bytes: 512 * 1024, data } };
      try {
        expect(decoder.accept(fragment, data.length)).toBeUndefined();
        const next = { $clarvis_message: { offset: 256 * 1024, bytes: 512 * 1024, data } };
        if (kind === "offset") next.$clarvis_message.offset++;
        if (kind === "size") next.$clarvis_message.bytes++;
        if (kind === "base64") next.$clarvis_message.data += "\n";
        if (kind === "shape") Object.assign(next.$clarvis_message, { extra: true });
        expect(() => decoder.accept(kind === "interleave" ? {} : next, data.length)).toThrow();
      } finally {
        decoder.close();
      }
    },
  );

  it("bounds incomplete transfer lifetime and releases its buffer on explicit close", () => {
    vi.useFakeTimers();
    let expired = 0;
    const decoder = new JsonMessageDecoder(() => {
      expired++;
    });
    const fragment = {
      $clarvis_message: {
        offset: 0,
        bytes: 512 * 1024,
        data: Buffer.alloc(256 * 1024).toString("base64"),
      },
    };
    try {
      decoder.accept(fragment, 1);
      vi.advanceTimersByTime(30_000);
      expect(expired).toBe(1);
      expect(decoder.accept({}, 2)).toEqual({ value: {}, bytes: 2 });
      decoder.accept(fragment, 1);
      decoder.close();
      vi.advanceTimersByTime(30_000);
      expect(expired).toBe(1);
    } finally {
      decoder.close();
      vi.useRealTimers();
    }
  });
});
