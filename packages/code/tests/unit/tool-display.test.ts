import { expect, test } from "bun:test";
import type { TranscriptNode } from "../../src/adapters/store.ts";
import {
  projectTranscriptToolDisplay,
  TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS,
  TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE,
} from "../../src/core/transcript/index.ts";
import { TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS } from "../../src/core/transcript/presenters.ts";

type ToolNode = Extract<TranscriptNode, { kind: "tool_call" }>;

function tool(over: Partial<ToolNode> = {}): ToolNode {
  return {
    key: "exec::tool",
    kind: "tool_call",
    status: "ok",
    text: "",
    mcpName: "server",
    toolName: "large_result",
    ...over,
  };
}

test("tool display caps a one-line result before any renderer can inspect it", () => {
  const raw = "x".repeat(TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS * 3);
  const node = tool({ result: raw });
  const display = projectTranscriptToolDisplay(node);

  expect(display.result).toHaveLength(TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS);
  expect(display.result).not.toContain(TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE);
  expect(display.truncated).toBe(true);
  expect(node.result).toBe(raw);
  expect(projectTranscriptToolDisplay(node)).toBe(display);
  expect(display.mountedTextChars).toBeGreaterThan(TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS);
  expect(display.mountedTextChars).toBeLessThanOrEqual(TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS);
});

test("tool display bounds argument traversal and serialization while preserving a useful prefix", () => {
  const node = tool({
    args: {
      path: "src/large.ts",
      content: "y".repeat(TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS * 3),
      nested: Array.from({ length: 2_000 }, (_, index) => ({ index, value: `v${index}` })),
    },
  });
  const display = projectTranscriptToolDisplay(node);

  expect(display.hasArguments).toBe(true);
  expect(display.argumentsText.length).toBeLessThanOrEqual(TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS);
  expect(display.argumentsText).toContain("src/large.ts");
  expect(display.argumentsText).not.toContain(TRANSCRIPT_TOOL_DISPLAY_SHORTENED_NOTICE);
  expect(String(display.arguments.content).length).toBeLessThan(
    TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS,
  );
  expect(display.truncated).toBe(true);
});

test("tool argument projection never invokes an arbitrary accessor", () => {
  let reads = 0;
  const args = Object.defineProperty({ path: "src/safe.ts" }, "secret", {
    enumerable: true,
    get() {
      reads += 1;
      return "must not be read";
    },
  });

  const display = projectTranscriptToolDisplay(tool({ args }));

  expect(reads).toBe(0);
  expect(display.arguments.path).toBe("src/safe.ts");
  expect(display.arguments.secret).toBe("[accessor omitted]");
});

test("tool argument projection treats prototype-shaped keys as inert own data", () => {
  const args = JSON.parse(
    '{"__proto__":{"polluted":"no"},"constructor":"literal","path":"src/file.ts"}',
  ) as Record<string, unknown>;
  const display = projectTranscriptToolDisplay(tool({ args }));

  expect(Object.getPrototypeOf(display.arguments)).toBeNull();
  expect(Object.hasOwn(display.arguments, "__proto__")).toBe(true);
  expect(Object.hasOwn(display.arguments, "constructor")).toBe(true);
  expect(display.argumentsText).toContain('"__proto__"');
  expect(({} as { polluted?: string }).polluted).toBeUndefined();
});

test("a value shared by two keys is projected twice, not reported as a cycle", () => {
  // `seen` tracks the path, not every object visited. Retaining it flagged an
  // ordinary shared reference as circular and raised the "display shortened"
  // banner on a call that was nothing of the sort.
  const shared = { mode: "fast", retries: 2 };
  const display = projectTranscriptToolDisplay(
    tool({ args: { primary: shared, secondary: shared, list: [shared, shared] } }),
  );

  expect(display.argumentsText).not.toContain("[circular value omitted]");
  expect(display.truncated).toBe(false);
  const projected = display.arguments as Record<string, Record<string, unknown>>;
  expect(projected.primary).toEqual({ mode: "fast", retries: 2 });
  expect(projected.secondary).toEqual({ mode: "fast", retries: 2 });
});

test("a genuine cycle is still caught after a sibling shares a reference", () => {
  const shared: Record<string, unknown> = { name: "shared" };
  const cyclic: Record<string, unknown> = { shared };
  cyclic.self = cyclic;
  const display = projectTranscriptToolDisplay(tool({ args: { first: shared, cyclic } }));

  expect(display.argumentsText).toContain("[circular value omitted]");
  expect(display.truncated).toBe(true);
});

test("tool argument projection handles collisions, sparse arrays, cycles and deep values", () => {
  const repeatedPrefix = "k".repeat(700);
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  let deep: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 20; index += 1) deep = { child: deep };
  const sparse: unknown[] = [];
  sparse.length = 3;
  sparse[1] = "middle";
  const args: Record<string, unknown> = {
    [`${repeatedPrefix}a`]: 1,
    [`${repeatedPrefix}b`]: 2,
    [`${repeatedPrefix}c`]: 3,
    sparse,
    circular,
    deep,
    infinite: Number.POSITIVE_INFINITY,
    bigint: 42n,
    absent: undefined,
  };

  const display = projectTranscriptToolDisplay(tool({ args }));
  const keys = Object.keys(display.arguments);

  expect(keys.some((key) => key.endsWith("#2"))).toBe(true);
  expect(keys.some((key) => key.endsWith("#3"))).toBe(true);
  expect(display.argumentsText).toContain("middle");
  expect(display.argumentsText).toContain("null");
  expect(display.argumentsText).toContain("[circular value omitted]");
  expect(display.argumentsText).toContain("[... omitted from live display ...]");
  expect(display.truncated).toBe(true);
});

test("each physical-publication snapshot bounds tool payloads before native mounting", () => {
  const raw = "z".repeat(TRANSCRIPT_TOOL_DISPLAY_FIELD_MAX_CHARS * 2);
  const nodes = Array.from({ length: 20 }, (_, index) =>
    tool({ key: `exec::tool-${index}`, result: raw }),
  );
  const displays = nodes.map((node) => projectTranscriptToolDisplay(node));
  expect(displays.every((display) => display.mountedTextChars > 0)).toBe(true);
  expect(
    displays.every((display) => display.mountedTextChars <= TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS),
  ).toBe(true);
  expect(nodes.every((node) => node.result === raw)).toBe(true);
});

test("tool display charges the header signature as well as its argument-derived body", () => {
  const node = tool({ toolName: "shell", args: { command: "x".repeat(40_000) } });
  const display = projectTranscriptToolDisplay(node);

  expect(display.mountedTextChars).toBeGreaterThan(display.argumentsText.length);
  expect(display.mountedTextChars).toBeLessThanOrEqual(TRANSCRIPT_MOUNTED_TEXT_MAX_CHARS);
});
