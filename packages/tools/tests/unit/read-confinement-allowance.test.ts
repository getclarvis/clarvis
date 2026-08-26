/**
 * The read tools admit the state root beside the workspace, and only they do.
 *
 * @remarks An oversized tool result is spilled outside the working tree and the
 * model is handed the path to read it back, so without this allowance
 * `confineToWorkspace` would reject Clarvis's own spill. The widening is
 * deliberately narrow — read-only, and only the two read tools pass
 * `config.stateRoot` to `resolvePath` — because a mutation reaching machinery
 * state would be a workspace escape wearing the same clothes.
 *
 * The engine's spill suite unit-tests writing the file; nothing anywhere read
 * one back through a confined tool, which is the single behaviour the widening
 * exists for.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { callTool, cleanup, makeConfig, makeWorkspace, write } from "../helpers/fixtures.ts";

let roots: string[] = [];
afterEach(() => {
  for (const r of roots) cleanup(r);
  roots = [];
});

/** A workspace plus a state root that is a genuine sibling, not a subdirectory. */
function workspaceWithState(): { root: string; stateRoot: string; spill: string } {
  const root = makeWorkspace();
  const stateRoot = mkdtempSync(path.join(tmpdir(), "clarvis-state-"));
  roots.push(root, stateRoot);
  const spill = path.join(stateRoot, "spill", "tool-result.txt");
  mkdirSync(path.dirname(spill), { recursive: true });
  writeFileSync(spill, "spilled line one\nspilled line two\n");
  return { root, stateRoot, spill };
}

describe("the stateRoot read allowance", () => {
  it("lets read_file open a spilled result while confinement is on", async () => {
    const { root, stateRoot, spill } = workspaceWithState();
    const res = await callTool(
      "read_file",
      { path: spill },
      makeConfig(root, { confineToWorkspace: true, stateRoot }),
    );

    expect(res.isError).toBe(false);
    expect(res.text).toContain("spilled line one");
  });

  it("lets read_files open one too, so a batch read is not the odd one out", async () => {
    const { root, stateRoot, spill } = workspaceWithState();
    write(root, "inside.txt", "workspace line\n");

    const res = await callTool(
      "read_files",
      { paths: [spill, path.join(root, "inside.txt")] },
      makeConfig(root, { confineToWorkspace: true, stateRoot }),
    );

    expect(res.isError).toBe(false);
    expect(res.text).toContain("spilled line one");
    expect(res.text).toContain("workspace line");
  });

  it("still refuses a path in neither the workspace nor the state root", async () => {
    const { root, stateRoot } = workspaceWithState();
    const outside = mkdtempSync(path.join(tmpdir(), "clarvis-outside-"));
    roots.push(outside);
    const target = path.join(outside, "secret.txt");
    writeFileSync(target, "not yours\n");

    const res = await callTool(
      "read_file",
      { path: target },
      makeConfig(root, { confineToWorkspace: true, stateRoot }),
    );

    expect(res.isError).toBe(true);
    expect(res.text).not.toContain("not yours");
  });

  it("does not extend the allowance to a tool that mutates", async () => {
    const { root, stateRoot, spill } = workspaceWithState();

    const res = await callTool(
      "write_file",
      { path: spill, content: "overwritten" },
      makeConfig(root, { confineToWorkspace: true, stateRoot }),
    );

    expect(res.isError).toBe(true);
  });
});
