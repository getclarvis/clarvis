import { describe, expect, it } from "bun:test";
import { boundJsonValue } from "../../src/core/bounded-json.ts";

const OPTIONS = { maxDepth: 8, maxNodes: 32, maxChars: 64 } as const;

describe("bounded JSON values", () => {
  it("bounds characters, nodes, depth, cycles, and unsupported primitives", () => {
    expect(boundJsonValue("long", { ...OPTIONS, maxChars: 0 })).toEqual({
      value: "",
      truncated: true,
    });
    expect(boundJsonValue(1, { ...OPTIONS, maxNodes: 0 })).toEqual({
      value: "[json node limit]",
      truncated: true,
    });
    expect(boundJsonValue([1, 2], { ...OPTIONS, maxNodes: 2 })).toEqual({
      value: [1],
      truncated: true,
    });
    expect(boundJsonValue(Symbol("opaque"), OPTIONS)).toEqual({
      value: "[unsupported symbol]",
      truncated: true,
    });
    expect(boundJsonValue({ nested: {} }, { ...OPTIONS, maxDepth: 1 })).toEqual({
      value: { nested: "[json depth limit]" },
      truncated: true,
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(boundJsonValue(circular, OPTIONS)).toEqual({
      value: { self: "[circular value]" },
      truncated: true,
    });
    expect(boundJsonValue(new Date(0), OPTIONS)).toEqual({
      value: "[unsupported object]",
      truncated: true,
    });
  });

  it("never invokes array accessors and contains unreadable array slots", () => {
    const accessor: unknown[] = [];
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => "secret" });
    accessor.length = 1;
    expect(boundJsonValue(accessor, OPTIONS)).toEqual({
      value: ["[accessor omitted]"],
      truncated: true,
    });

    const unreadable = new Proxy(["value"], {
      getOwnPropertyDescriptor() {
        throw new Error("descriptor denied");
      },
    });
    expect(boundJsonValue(unreadable, OPTIONS)).toEqual({
      value: ["[unreadable value]"],
      truncated: true,
    });
  });

  it("bounds object enumeration and contains descriptor/proxy failures", () => {
    expect(boundJsonValue({ first: "123", second: "456" }, { ...OPTIONS, maxChars: 8 })).toEqual({
      value: { first: "123" },
      truncated: true,
    });

    let descriptorReads = 0;
    const unreadableProperty = new Proxy(
      { value: "secret" },
      {
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          if (descriptorReads > 2) throw new Error("descriptor denied");
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    expect(boundJsonValue(unreadableProperty, OPTIONS)).toEqual({
      value: { value: "[unreadable value]" },
      truncated: true,
    });

    const unreadableObject = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype denied");
        },
      },
    );
    expect(boundJsonValue(unreadableObject, OPTIONS)).toEqual({
      value: "[unreadable value]",
      truncated: true,
    });
  });
});
