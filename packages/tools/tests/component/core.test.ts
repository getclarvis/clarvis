import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { toolDescriptors, tools } from "../../src/tools/registry.ts";
import { dispatch, listTools } from "../../src/core.ts";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  resultText,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";
import { EXPECTED_TOOL_DESCRIPTORS } from "../helpers/tool-surface.ts";

describe("core / registry", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("owns the canonical tool descriptors and derives the full registry", () => {
    expect(toolDescriptors.map(({ tool, readOnly }) => ({ name: tool.name, readOnly }))).toEqual([
      ...EXPECTED_TOOL_DESCRIPTORS,
    ]);
    // A descriptor carries exactly two fields. A third — a capability bit that
    // makes the surface conditional again — must be a deliberate change here and
    // in the oracle, never an optional property that silently defaults.
    for (const descriptor of toolDescriptors) {
      expect(Object.keys(descriptor).sort(), descriptor.tool.name).toEqual(["readOnly", "tool"]);
    }
    expect(tools).toEqual(toolDescriptors.map(({ tool }) => tool));
  });

  it("does not set additionalProperties: false (allows extra fields)", () => {
    for (const t of tools) {
      expect(t.inputSchema.additionalProperties).not.toBe(false);
    }
  });

  it("an unknown tool name returns a not_found tool error (no throw)", async () => {
    const r = await dispatch("does_not_exist", {}, config);
    expect(r.isError).toBe(true);
    expect(JSON.parse(resultText(r.content))).toMatchObject({ error: "not_found" });
  });
});

describe("dispatch — input validation", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("returns invalid_input when a required arg is missing (no throw)", async () => {
    const r = await callTool("read_file", {}, config);
    expect(r.isError).toBe(true);
    expect(r.json).toMatchObject({ error: "invalid_input" });
    expect(typeof r.json.message).toBe("string");
    expect((r.json.message as string).length).toBeGreaterThan(0);
  });

  it("returns invalid_input when an arg is wrong-typed and not coercible", async () => {
    const r = await dispatch("read_file", { path: {} }, config);
    expect(r.isError).toBe(true);
    const json = JSON.parse(resultText(r.content)) as Record<string, unknown>;
    expect(json.error).toBe("invalid_input");
    expect(json.message).not.toBe("invalid arguments");
  });

  it("ignores unknown arguments instead of rejecting them", async () => {
    const r = await dispatch("read_file", { path: "a.txt", bogus: true }, config);
    const json = JSON.parse(resultText(r.content)) as Record<string, unknown>;
    expect(json.error).not.toBe("invalid_input");
  });
});

describe("dispatch — success and error routing", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("returns a bounded tool's handler output verbatim on success", async () => {
    write(root, "hello.txt", "line one\nline two\n");
    const r = await dispatch("read_file", { path: "hello.txt" }, config);
    expect(r.isError).toBe(false);
    expect(resultText(r.content)).toContain("line one");
    expect(resultText(r.content)).toContain("line two");
  });

  it("routes an unbounded tool's output through the byte-bounder on success", async () => {
    write(root, "a.txt", "x");
    const r = await dispatch("list_dir", {}, config);
    expect(r.isError).toBe(false);
    expect(resultText(r.content)).toContain("a.txt");
  });

  it("catches a handler error thrown at runtime and serializes it", async () => {
    const r = await dispatch("read_file", { path: "does-not-exist.txt" }, config);
    expect(r.isError).toBe(true);
    expect(JSON.parse(resultText(r.content))).toMatchObject({ error: "not_found" });
  });
});

describe("listTools surface", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("returns the full surface with schemas", () => {
    const infos = listTools(config);
    expect(infos.length).toBeGreaterThan(0);
    for (const info of infos) {
      expect(typeof info.name).toBe("string");
      expect(typeof info.description).toBe("string");
      expect(info.inputSchema.additionalProperties).not.toBe(false);
    }
  });

  it("tells the model that large output is cut, on every tool that can emit it", () => {
    const byName = new Map(listTools(config).map((t) => [t.name, t.description]));
    for (const name of ["shell", "grep", "read_file"]) {
      expect(byName.get(name)).toContain("byte-bounded");
    }
  });

  it("names the end an oversized result actually loses, per tool", () => {
    // Neither shape drops a *middle*: `bound`/`renderNumberedSlice` keep the
    // head, `boundOrSpill` keeps the tail. A description saying otherwise has
    // the model reasoning about which part of a large result it holds from a
    // false premise.
    const byName = new Map(listTools(config).map((t) => [t.name, t.description]));
    expect(byName.get("shell")).toContain("loses its head");
    for (const name of ["grep", "read_file"]) {
      expect(byName.get(name)).toContain("loses its tail");
    }
    for (const name of ["shell", "grep", "read_file"]) {
      expect(byName.get(name)).not.toContain("middle of an oversized result is dropped");
    }
  });
});
