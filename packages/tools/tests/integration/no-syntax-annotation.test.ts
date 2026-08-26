/**
 * A write result reports what it wrote, and nothing else.
 *
 * @remarks Every write tool used to append a `warning: <grammar> syntax error …`
 * line parsed out of tree-sitter. That annotation is why a single `write_file`
 * on a `.ts` file loaded a 64 MiB emscripten heap the process never released,
 * whether or not the model had ever asked for a parse — so its absence is the
 * property worth a regression test, not an implementation detail.
 *
 * One file owns all five tools rather than a `not.toContain("warning:")` spread
 * across five suites, which is the matrix-without-an-owner shape
 * `specs/cross-cutting/test-architecture.md` rules out. It matters most for `multi_edit`,
 * which never called the annotation directly — it inherited it through
 * `editFileLocked` in `edit-file.ts`, so a removal that only edited
 * `write-file.ts` would have left `multi_edit` annotated and a per-tool spot
 * check would not have noticed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { contentText, createAgentTools, type AgentTools } from "../../src/index.ts";
import { cleanup, makeWorkspace, write } from "../helpers/fixtures.ts";

/** The content that used to produce `warning: typescript syntax error …`. */
const BROKEN_TS = "const x = = 1;\n";

/** Tokens the removed annotation would have put into a success line. */
const ANNOTATION_TOKENS = ["warning:", "syntax", "check_syntax", "parse"] as const;

describe("a write result carries no syntax annotation", () => {
  let root: string;
  let tools: AgentTools;

  beforeEach(() => {
    root = makeWorkspace();
    tools = createAgentTools({ workspaceRoot: root, probeRipgrep: () => false });
  });
  afterEach(() => cleanup(root));

  it("write_file returns the success line and nothing after it", async () => {
    const result = await tools.callTool("write_file", { path: "broken.ts", content: BROKEN_TS });
    expect(result.isError).toBe(false);
    // Equality, not `startsWith`: the annotation was appended, so only an exact
    // match proves nothing follows.
    expect(contentText(result.content)).toBe("Wrote 15 bytes to broken.ts (created).");
  });

  it.each([
    {
      tool: "edit_file",
      seed: { rel: "a.ts", text: "const x = 1;\n" },
      args: { path: "a.ts", old_string: "const x = 1;", new_string: "const x = = 1;" },
    },
    {
      tool: "multi_edit",
      seed: { rel: "b.ts", text: "const y = 1;\n" },
      args: { path: "b.ts", edits: [{ old_string: "const y = 1;", new_string: "const y = = 1;" }] },
    },
    {
      tool: "replace",
      seed: { rel: "c.ts", text: "const z = 1;\n" },
      args: { pattern: "= 1", replacement: "= = 1", path: "c.ts", dry_run: false },
    },
    {
      tool: "apply_patch",
      seed: { rel: "d.ts", text: "const w = 1;\n" },
      args: { patch: "--- a/d.ts\n+++ b/d.ts\n@@ -1,1 +1,1 @@\n-const w = 1;\n+const w = = 1;\n" },
    },
  ])(
    "$tool appends nothing when the written content does not parse",
    async ({ tool, seed, args }) => {
      write(root, seed.rel, seed.text);
      const result = await tools.callTool(tool, args);
      expect(result.isError, tool).toBe(false);
      const text = contentText(result.content).toLowerCase();
      for (const token of ANNOTATION_TOKENS) {
        expect(text, `${tool} / ${token}`).not.toContain(token);
      }
    },
  );
});
