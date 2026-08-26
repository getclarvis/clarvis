import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { lstatSync } from "node:fs";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  read,
  makeSymlink,
  canSymlink,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe.skipIf(!canSymlink)("symlink write semantics (BUG-10 / TEST-05)", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
    write(root, "real.txt", "original\n");
    makeSymlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
  });
  afterEach(() => cleanup(root));

  it("read_file follows a symlink to its target", async () => {
    const r = await callTool("read_file", { path: "link.txt" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toContain("original");
  });

  it("write_file refuses a symlink and leaves target + link intact", async () => {
    const r = await callTool("write_file", { path: "link.txt", content: "new\n" }, config);
    expect(r.json.error).toBe("invalid_input");
    expect(read(root, "real.txt")).toBe("original\n");
    expect(lstatSync(path.join(root, "link.txt")).isSymbolicLink()).toBe(true);
  });

  it("edit_file refuses a symlink and leaves the target unchanged", async () => {
    const r = await callTool(
      "edit_file",
      { path: "link.txt", old_string: "original", new_string: "changed" },
      config,
    );
    expect(r.json.error).toBe("invalid_input");
    expect(read(root, "real.txt")).toBe("original\n");
    expect(lstatSync(path.join(root, "link.txt")).isSymbolicLink()).toBe(true);
  });
});
