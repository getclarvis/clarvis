import { describe, expect, it } from "bun:test";

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { loadMemoryPolicy } from "../../src/recording-policy.ts";
import { makeRoot } from "../helpers/fs.ts";

const GLOBAL = "Always keep the exact commands, never a paraphrase.";
const WORKSPACE = "Record the migration traps in this repo.";

describe("reading the two authored files", () => {
  it("composes what is on disk, personal scope first", async () => {
    const { root, cleanup } = await makeRoot();
    await fs.writeFile(join(root, "g.md"), GLOBAL, "utf8");
    await fs.writeFile(join(root, "w.md"), WORKSPACE, "utf8");
    const composed = loadMemoryPolicy({
      global: join(root, "g.md"),
      workspace: join(root, "w.md"),
    })!;
    expect(composed.indexOf(GLOBAL)).toBeLessThan(composed.indexOf(WORKSPACE));
    await cleanup();
  });

  it("treats a missing file exactly as an absent scope", async () => {
    const { root, cleanup } = await makeRoot();
    await fs.writeFile(join(root, "w.md"), WORKSPACE, "utf8");
    const composed = loadMemoryPolicy({
      global: join(root, "nope.md"),
      workspace: join(root, "w.md"),
    })!;
    expect(composed).toContain(WORKSPACE);
    await cleanup();
  });

  it("treats a blank file as absent, so emptying one is how it is turned off", async () => {
    const { root, cleanup } = await makeRoot();
    await fs.writeFile(join(root, "g.md"), "   \n\t\n ", "utf8");
    await fs.writeFile(join(root, "w.md"), "", "utf8");
    expect(
      loadMemoryPolicy({ global: join(root, "g.md"), workspace: join(root, "w.md") }),
    ).toBeUndefined();
    await cleanup();
  });

  it("is absent when neither file exists at all", async () => {
    const { root, cleanup } = await makeRoot();
    expect(
      loadMemoryPolicy({ global: join(root, "a.md"), workspace: join(root, "b.md") }),
    ).toBeUndefined();
    await cleanup();
  });

  it("reads a directory as absent rather than throwing", async () => {
    const { root, cleanup } = await makeRoot();
    await fs.mkdir(join(root, "dir.md"));
    await fs.writeFile(join(root, "w.md"), WORKSPACE, "utf8");
    expect(
      loadMemoryPolicy({ global: join(root, "dir.md"), workspace: join(root, "w.md") }),
    ).toContain(WORKSPACE);
    await cleanup();
  });
});
