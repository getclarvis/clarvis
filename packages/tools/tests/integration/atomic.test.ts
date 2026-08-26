import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { promises as fsp, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import type { PathLike, Stats } from "node:fs";
import { makeWorkspace, cleanup, write, read, exists } from "../helpers/fixtures.ts";
import { applyOpsAtomic } from "../../src/lib/atomic.ts";
import type { FileOp } from "../../src/lib/atomic.ts";
import { ToolError } from "../../src/errors.ts";

async function catchErr(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected the promise to reject, but it resolved");
    },
    (e: unknown) => e,
  );
}

function tmpFiles(root: string): string[] {
  return readdirSync(root).filter((f) => f.startsWith(".clarvis-tmp"));
}

describe("applyOpsAtomic — committing operations", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(root);
  });

  it("creates an empty file when a create op omits its content", async () => {
    const newP = path.join(root, "fresh", "created.txt");
    const ops: FileOp[] = [{ type: "create", path: newP }];
    expect(applyOpsAtomic(ops)).resolves.toBeUndefined();
    expect(exists(root, "fresh/created.txt")).toBe(true);
    expect(read(root, "fresh/created.txt")).toBe("");
    expect(tmpFiles(root)).toHaveLength(0);
  });

  it("commits a content-rename followed by a delete of the moved file", async () => {
    write(root, "Q.txt", "orig");
    const Q = path.join(root, "Q.txt");
    const P = path.join(root, "P.txt");
    const ops: FileOp[] = [
      { type: "rename", path: P, from: Q, content: "moved" },
      { type: "delete", path: P },
    ];
    expect(applyOpsAtomic(ops)).resolves.toBeUndefined();
    expect(exists(root, "Q.txt")).toBe(false);
    expect(exists(root, "P.txt")).toBe(false);
    expect(tmpFiles(root)).toHaveLength(0);
  });
});

describe("applyOpsAtomic — target validation", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(root);
  });

  it("throws not_found when a rename source does not exist", async () => {
    const ops: FileOp[] = [
      { type: "rename", path: path.join(root, "dest.txt"), from: path.join(root, "missing.txt") },
    ];
    const err = (await catchErr(applyOpsAtomic(ops))) as ToolError;
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("not_found");
    expect(tmpFiles(root)).toHaveLength(0);
  });

  it("rethrows a non-ENOENT stat error for the rename source", async () => {
    const fromPath = path.join(root, "blocker", "child");
    const realStat = fsp.stat.bind(fsp);
    vi.spyOn(fsp, "stat").mockImplementation(((p: PathLike) => {
      if (p === fromPath) {
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      }
      return (realStat as (pp: PathLike) => Promise<Stats>)(p);
    }) as typeof fsp.stat);

    const ops: FileOp[] = [{ type: "rename", path: path.join(root, "dest2.txt"), from: fromPath }];
    const err = (await catchErr(applyOpsAtomic(ops))) as NodeJS.ErrnoException;
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("EACCES");
    expect(err).not.toBeInstanceOf(ToolError);
  });

  it("throws not_a_file when the rename source is a directory", async () => {
    mkdirSync(path.join(root, "srcdir"));
    const ops: FileOp[] = [
      { type: "rename", path: path.join(root, "dest3.txt"), from: path.join(root, "srcdir") },
    ];
    const err = (await catchErr(applyOpsAtomic(ops))) as ToolError;
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("not_a_file");
  });

  it("rethrows a non-ENOENT stat error for the rename destination", async () => {
    write(root, "src.txt", "hi");
    const toPath = path.join(root, "to.txt");
    const realStat = fsp.stat.bind(fsp);
    vi.spyOn(fsp, "stat").mockImplementation(((p: PathLike) => {
      if (p === toPath) {
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      }
      return (realStat as (pp: PathLike) => Promise<Stats>)(p);
    }) as typeof fsp.stat);

    const ops: FileOp[] = [{ type: "rename", path: toPath, from: path.join(root, "src.txt") }];
    const err = (await catchErr(applyOpsAtomic(ops))) as NodeJS.ErrnoException;
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("EACCES");
    expect(err).not.toBeInstanceOf(ToolError);
  });

  it("throws not_a_file when a create or modify target is an existing directory", async () => {
    mkdirSync(path.join(root, "dir196"));
    const ops: FileOp[] = [{ type: "modify", path: path.join(root, "dir196"), content: "x" }];
    const err = (await catchErr(applyOpsAtomic(ops))) as ToolError;
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("not_a_file");
    expect(tmpFiles(root)).toHaveLength(0);
  });

  it("rethrows a non-ENOENT stat error for a create or modify target", async () => {
    const target = path.join(root, "guarded.txt");
    const realStat = fsp.stat.bind(fsp);
    vi.spyOn(fsp, "stat").mockImplementation(((p: PathLike) => {
      if (p === target) {
        return Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" }));
      }
      return (realStat as (pp: PathLike) => Promise<Stats>)(p);
    }) as typeof fsp.stat);

    const ops: FileOp[] = [{ type: "create", path: target, content: "x" }];
    const err = (await catchErr(applyOpsAtomic(ops))) as NodeJS.ErrnoException;
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("EACCES");
    expect(err).not.toBeInstanceOf(ToolError);
    expect(tmpFiles(root)).toHaveLength(0);
  });
});

describe("applyOpsAtomic — rollback", () => {
  let root: string;

  beforeEach(() => {
    root = makeWorkspace();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup(root);
  });

  it("undoes a committed pure rename when a later op fails", async () => {
    write(root, "A.txt", "A-content");
    write(root, "C.txt", "C-content");
    const A = path.join(root, "A.txt");
    const B = path.join(root, "B.txt");
    const C = path.join(root, "C.txt");

    const realRename = fsp.rename.bind(fsp);
    let firedC = false;
    vi.spyOn(fsp, "rename").mockImplementation((src: PathLike, dst: PathLike) => {
      if (dst === C && !firedC) {
        firedC = true;
        return Promise.reject(Object.assign(new Error("boom"), { code: "EIO" }));
      }
      return realRename(src, dst);
    });

    const ops: FileOp[] = [
      { type: "rename", path: B, from: A },
      { type: "modify", path: C, content: "new" },
    ];
    const err = (await catchErr(applyOpsAtomic(ops))) as Error;
    expect(err).not.toBeInstanceOf(ToolError);
    expect(err.message).toBe("boom");

    expect(exists(root, "A.txt")).toBe(true);
    expect(read(root, "A.txt")).toBe("A-content");
    expect(exists(root, "B.txt")).toBe(false);
    expect(read(root, "C.txt")).toBe("C-content");
    expect(tmpFiles(root)).toHaveLength(0);
  });

  it("reports unrestored paths as io_error when rollback itself fails", async () => {
    write(root, "A.txt", "A-content");
    write(root, "C.txt", "C-content");
    const A = path.join(root, "A.txt");
    const B = path.join(root, "B.txt");
    const C = path.join(root, "C.txt");

    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation((src: PathLike, dst: PathLike) => {
      if (dst === C || dst === A) {
        return Promise.reject(Object.assign(new Error("boom"), { code: "EIO" }));
      }
      return realRename(src, dst);
    });

    const ops: FileOp[] = [
      { type: "rename", path: B, from: A },
      { type: "modify", path: C, content: "new" },
    ];
    const err = (await catchErr(applyOpsAtomic(ops))) as ToolError;
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("io_error");
    expect(err.message).toContain("boom");
    expect(err.message).toContain("rollback could not restore");
    expect(err.message).toContain(A);
  });

  it("rolls back a committed delete and a no-backup create when a later op fails", async () => {
    write(root, "D.txt", "D-content");
    write(root, "F.txt", "F-content");
    const D = path.join(root, "D.txt");
    const E = path.join(root, "E.txt");
    const F = path.join(root, "F.txt");

    const realRename = fsp.rename.bind(fsp);
    let firedF = false;
    vi.spyOn(fsp, "rename").mockImplementation((src: PathLike, dst: PathLike) => {
      if (dst === F && !firedF) {
        firedF = true;
        return Promise.reject(Object.assign(new Error("boom"), { code: "EIO" }));
      }
      return realRename(src, dst);
    });

    const ops: FileOp[] = [
      { type: "delete", path: D },
      { type: "create", path: E },
      { type: "modify", path: F, content: "new" },
    ];
    const err = (await catchErr(applyOpsAtomic(ops))) as Error;
    expect(err).not.toBeInstanceOf(ToolError);
    expect(err.message).toBe("boom");

    expect(exists(root, "D.txt")).toBe(true);
    expect(read(root, "D.txt")).toBe("D-content");
    expect(exists(root, "E.txt")).toBe(false);
    expect(read(root, "F.txt")).toBe("F-content");
    expect(tmpFiles(root)).toHaveLength(0);
  });

  it("rolls back a pure rename that fails during its own commit", async () => {
    write(root, "A.txt", "A-content");
    const A = path.join(root, "A.txt");
    const B = path.join(root, "B.txt");

    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation((src: PathLike, dst: PathLike) => {
      if (dst === B) return Promise.reject(Object.assign(new Error("boom"), { code: "EIO" }));
      return realRename(src, dst);
    });

    const ops: FileOp[] = [{ type: "rename", path: B, from: A }];
    const err = (await catchErr(applyOpsAtomic(ops))) as Error;
    expect(err).not.toBeInstanceOf(ToolError);
    expect(err.message).toBe("boom");

    expect(exists(root, "A.txt")).toBe(true);
    expect(read(root, "A.txt")).toBe("A-content");
    expect(exists(root, "B.txt")).toBe(false);
    expect(tmpFiles(root)).toHaveLength(0);
  });

  it("reports the from-path when a content-rename rollback fails", async () => {
    write(root, "A.txt", "A-content");
    write(root, "C.txt", "C-content");
    const A = path.join(root, "A.txt");
    const B = path.join(root, "B.txt");
    const C = path.join(root, "C.txt");

    const realRename = fsp.rename.bind(fsp);
    vi.spyOn(fsp, "rename").mockImplementation((src: PathLike, dst: PathLike) => {
      if (dst === C || dst === A) {
        return Promise.reject(Object.assign(new Error("boom"), { code: "EIO" }));
      }
      return realRename(src, dst);
    });

    const ops: FileOp[] = [
      { type: "rename", path: B, from: A, content: "moved-content" },
      { type: "modify", path: C, content: "new" },
    ];
    const err = (await catchErr(applyOpsAtomic(ops))) as ToolError;
    expect(err).toBeInstanceOf(ToolError);
    expect(err.code).toBe("io_error");
    expect(err.message).toContain("rollback could not restore");
    expect(err.message).toContain(A);
  });
});
