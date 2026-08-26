import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { selectSurface, tools } from "../../src/tools/registry.ts";
import { dispatch } from "../../src/core.ts";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  read,
  resultText,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";
import { EXPECTED_TOOL_DESCRIPTORS, expectedToolNames } from "../helpers/tool-surface.ts";

const HIDDEN_TOOLS = EXPECTED_TOOL_DESCRIPTORS.filter(({ readOnly }) => !readOnly).map(
  ({ name }) => name,
);

describe("read-only surface", () => {
  let root: string;
  let ro: ServerConfig;
  let full: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    ro = makeConfig(root, { readOnly: true });
    full = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("derives the read-only and full surfaces from the canonical descriptors", () => {
    expect(selectSurface(true).map(({ name }) => name)).toEqual(
      expectedToolNames({ readOnly: true }),
    );
    const names = new Set(selectSurface(true).map((t) => t.name));
    for (const hidden of HIDDEN_TOOLS) {
      expect(names.has(hidden), hidden).toBe(false);
    }
    expect(selectSurface(false)).toBe(tools);
    expect(selectSurface(false).map(({ name }) => name)).toEqual(
      expectedToolNames({ readOnly: false }),
    );
  });

  it("a hidden tool and an unknown name are indistinguishable not_found errors", async () => {
    const bogus = await dispatch("does_not_exist", {}, ro);
    expect(bogus.isError).toBe(true);
    const bogusErr = JSON.parse(resultText(bogus.content)) as { error: string };
    expect(bogusErr.error).toBe("not_found");
    for (const hidden of HIDDEN_TOOLS) {
      const res = await dispatch(hidden, {}, ro);
      expect(res.isError, hidden).toBe(true);
      const err = JSON.parse(resultText(res.content)) as { error: string };
      expect(err.error, hidden).toBe(bogusErr.error);
    }
  });

  it("the text read tools behave identically full vs read-only", async () => {
    write(root, "a.txt", "alpha\nbeta\ngamma\n");
    write(root, "sub/b.ts", "export const x = 1;\n");
    const cases: Array<[string, Record<string, unknown>]> = [
      ["read_file", { path: "a.txt" }],
      ["list_dir", {}],
      ["glob", { pattern: "**/*.ts" }],
      ["grep", { pattern: "alpha" }],
    ];
    for (const [name, args] of cases) {
      const rFull = await callTool(name, args, full);
      const rRo = await callTool(name, args, ro);
      expect(rRo, name).toEqual(rFull);
      expect(rRo.isError, name).toBe(false);
    }
  });

  it("a read-only session leaves the workspace byte-identical", async () => {
    write(root, "keep.txt", "original\n");
    await callTool("read_file", { path: "keep.txt" }, ro);
    await callTool("list_dir", {}, ro);
    await callTool("glob", { pattern: "**/*" }, ro);
    await callTool("grep", { pattern: "orig" }, ro);

    const blocked = await dispatch("write_file", { path: "keep.txt", content: "changed\n" }, ro);
    expect(blocked.isError).toBe(true);
    expect(read(root, "keep.txt")).toBe("original\n");
  });
});
