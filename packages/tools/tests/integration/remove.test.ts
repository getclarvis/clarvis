import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdirSync, promises as fsp, rmSync } from "node:fs";
import path from "node:path";
import {
  makeWorkspace,
  cleanup,
  makeConfig,
  callTool,
  write,
  exists,
  chmod,
  modeBitsEnforced,
  makeSymlink,
} from "../helpers/fixtures.ts";
import type { ServerConfig } from "../../src/config.ts";

describe("remove", () => {
  let root: string;
  let config: ServerConfig;

  beforeEach(() => {
    root = makeWorkspace();
    config = makeConfig(root);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(root);
  });

  it("deletes a file", async () => {
    write(root, "a.txt", "x");
    const r = await callTool("remove", { path: "a.txt" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Removed a.txt.");
    expect(exists(root, "a.txt")).toBe(false);
  });

  it("errors not_found when the path does not exist", async () => {
    const r = await callTool("remove", { path: "nope.txt" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("not_found");
  });

  it("removes an empty directory", async () => {
    mkdirSync(path.join(root, "d"));
    const r = await callTool("remove", { path: "d" }, config);
    expect(r.isError).toBe(false);
    expect(r.text).toBe("Removed empty directory d.");
    expect(exists(root, "d")).toBe(false);
  });

  it("treats recursive removal of an empty ordinary directory as rmdir", async () => {
    mkdirSync(path.join(root, "empty"));
    const result = await callTool("remove", { path: "empty", recursive: true }, config);
    expect(result.isError).toBe(false);
    expect(result.text).toBe("Removed empty directory empty.");
    expect(exists(root, "empty")).toBe(false);
  });

  it("refuses a nonempty directory without changing its entries", async () => {
    write(root, "d/a.txt", "x");
    const r = await callTool("remove", { path: "d" }, config);
    expect(r.isError).toBe(true);
    expect(r.json.error).toBe("invalid_input");
    expect(exists(root, "d")).toBe(true);
    expect(exists(root, "d/a.txt")).toBe(true);
  });

  it("reviews an empty-directory deletion before commit", async () => {
    mkdirSync(path.join(root, "d"));
    let reviewed: unknown;
    config = {
      ...config,
      reviewMutation: async (operations, commit) => {
        reviewed = operations;
        await commit();
      },
    };
    const r = await callTool("remove", { path: "d" }, config);
    expect(r.isError).toBe(false);
    expect(reviewed).toEqual([{ type: "rmdir", path: path.join(root, "d") }]);
    expect(exists(root, "d")).toBe(false);
  });

  it("requires review for a bounded recursive cleanup and removes the approved tree", async () => {
    write(root, "tree/nested/a.txt", "x");
    let prepared: unknown;
    const unavailable = await callTool("remove", { path: "tree", recursive: true }, config);
    expect(unavailable.json.error).toBe("approval_unavailable");
    expect(exists(root, "tree/nested/a.txt")).toBe(true);
    config = {
      ...config,
      reviewMutation: async (operations, commit) => {
        prepared = operations;
        expect(exists(root, "tree/nested/a.txt")).toBe(true);
        await commit();
      },
    };
    const result = await callTool("remove", { path: "tree", recursive: true }, config);
    expect(result.isError).toBe(false);
    expect(prepared).toMatchObject([
      {
        type: "rmtree",
        path: path.join(root, "tree"),
        treeEntries: [".", "nested", path.join("nested", "a.txt")],
      },
    ]);
    expect(exists(root, "tree")).toBe(false);
  });

  it("refuses recursive cleanup if the tree disappears during review", async () => {
    write(root, "tree/a.txt", "x");
    config = {
      ...config,
      reviewMutation: async (_operations, commit) => {
        rmSync(path.join(root, "tree"), { recursive: true });
        await commit();
      },
    };
    const result = await callTool("remove", { path: "tree", recursive: true }, config);
    expect(result.json.error).toBe("revision_conflict");
  });

  it("reports a partial recursive cleanup when a removal fails after an entry disappears", async () => {
    write(root, "tree/a.txt", "x");
    write(root, "tree/b.txt", "y");
    const target = path.join(root, "tree");
    const originalRm = fsp.rm.bind(fsp);
    vi.spyOn(fsp, "rm").mockImplementation((async (file: Parameters<typeof fsp.rm>[0], options) => {
      if (file === target) {
        await originalRm(path.join(target, "a.txt"));
        throw Object.assign(new Error("simulated partial removal"), { code: "EIO" });
      }
      return originalRm(file, options);
    }) as typeof fsp.rm);
    config = { ...config, reviewMutation: async (_operations, commit) => commit() };
    const result = await callTool("remove", { path: "tree", recursive: true }, config);
    expect(result.json.error).toBe("commit_partial");
    expect(exists(root, "tree/a.txt")).toBe(false);
    expect(exists(root, "tree/b.txt")).toBe(true);
  });

  it("reports a raced entry when an empty directory fills before commit", async () => {
    mkdirSync(path.join(root, "d"));
    config = {
      ...config,
      reviewMutation: async (_operations, commit) => {
        write(root, "d/raced.txt", "x");
        await commit();
      },
    };
    const result = await callTool("remove", { path: "d" }, config);
    expect(result.json.error).toBe("invalid_input");
    expect(exists(root, "d/raced.txt")).toBe(true);
  });

  it("refuses a recursive tree containing a symlink without changing it", async () => {
    write(root, "tree/a.txt", "x");
    makeSymlink(path.join(root, "tree", "a.txt"), path.join(root, "tree", "link"));
    config = { ...config, reviewMutation: async (_operations, commit) => commit() };
    const result = await callTool("remove", { path: "tree", recursive: true }, config);
    expect(result.json.error).toBe("denied");
    expect(exists(root, "tree/a.txt")).toBe(true);
  });

  it("refuses an oversized recursive preview before review", async () => {
    for (let index = 0; index < 64; index++) write(root, `tree/file-${index}.txt`, String(index));
    let reviewed = false;
    config = {
      ...config,
      reviewMutation: async (_operations, commit) => {
        reviewed = true;
        await commit();
      },
    };
    const result = await callTool("remove", { path: "tree", recursive: true }, config);
    expect(result.json.error).toBe("too_large");
    expect(reviewed).toBe(false);
    expect(exists(root, "tree/file-0.txt")).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "refuses a tree whose file names could spoof the approval preview",
    async () => {
      write(root, "tree/one\ntwo.txt", "x");
      let reviewed = false;
      config = {
        ...config,
        reviewMutation: async (_operations, commit) => {
          reviewed = true;
          await commit();
        },
      };
      const result = await callTool("remove", { path: "tree", recursive: true }, config);
      expect(result.json.error).toBe("denied");
      expect(reviewed).toBe(false);
      expect(exists(root, "tree/one\ntwo.txt")).toBe(true);
    },
  );

  it("refuses recursive cleanup around a selected skill root", async () => {
    write(root, "tree/skill/SKILL.md", "selected");
    config = {
      ...config,
      skillExecutionRoots: [path.join(root, "tree", "skill")],
      reviewMutation: async (_operations, commit) => commit(),
    };
    const result = await callTool("remove", { path: "tree", recursive: true }, config);
    expect(result.json.error).toBe("path_escape");
    expect(exists(root, "tree/skill/SKILL.md")).toBe(true);
  });

  it("deletes a symlink entry without changing its destination", async () => {
    write(root, "real.txt", "x");
    makeSymlink(path.join(root, "real.txt"), path.join(root, "link.txt"));
    const r = await callTool("remove", { path: "link.txt" }, config);
    expect(r.isError).toBe(false);
    expect(exists(root, "real.txt")).toBe(true);
    expect(exists(root, "link.txt")).toBe(false);
  });

  it("recursive cleanup refuses a symlink entry even when its target is a directory", async () => {
    write(root, "real/a.txt", "x");
    makeSymlink(path.join(root, "real"), path.join(root, "link"));
    config = { ...config, reviewMutation: async (_operations, commit) => commit() };
    const result = await callTool("remove", { path: "link", recursive: true }, config);
    expect(result.json.error).toBe("invalid_input");
    expect(exists(root, "link")).toBe(true);
    expect(exists(root, "real/a.txt")).toBe(true);
  });

  it.skipIf(!modeBitsEnforced)(
    "reports io_error when the parent directory is read-only",
    async () => {
      write(root, "ro/a.txt", "x");
      chmod(root, "ro", 0o555);
      try {
        const r = await callTool("remove", { path: "ro/a.txt" }, config);
        expect(r.isError).toBe(true);
        expect(r.json.error).toBe("io_error");
        expect(exists(root, "ro/a.txt")).toBe(true);
      } finally {
        chmod(root, "ro", 0o755);
      }
    },
  );

  it("reports a missing parent-relative path using the OS error", async () => {
    const r = await callTool("remove", { path: "../a.txt" }, config);
    expect(r.json.error).toBe("not_found");
  });

  it("ignores out-of-schema extra fields", async () => {
    write(root, "a.txt", "x");
    const r = await callTool("remove", { path: "a.txt", bogus: true }, config);
    expect(r.isError).toBe(false);
    expect(exists(root, "a.txt")).toBe(false);
  });
});
