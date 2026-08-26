import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { makeWorkspace, cleanup, makeConfig, callTool, write } from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("statelessness", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => cleanup(root));

  it("two identical reads reflect an out-of-band change between them", async () => {
    write(root, "f.txt", "before\n");
    const first = await callTool("read_file", { path: "f.txt" }, config);
    expect(first.text).toBe("     1\tbefore");

    writeFileSync(path.join(root, "f.txt"), "after\n");
    const second = await callTool("read_file", { path: "f.txt" }, config);
    expect(second.text).toBe("     1\tafter");
    expect(second.text).not.toBe(first.text);
  });

  it("a file created out-of-band becomes visible to a subsequent identical list", async () => {
    const before = await callTool("list_dir", {}, config);
    expect(before.text).toBe("(empty directory)");
    write(root, "new.txt", "x");
    const after = await callTool("list_dir", {}, config);
    expect(after.text).toBe("new.txt\t1");
  });
});
