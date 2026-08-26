import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFileMemoryProvider, FILE_PROVIDER_KIND } from "../../src/file-provider.ts";
import { MEMORY_READ_TOOL_NAMES } from "../../src/provider.ts";

const DOCTRINE = "# Constitution\n\nAlways pin the toolchain.\nNever edit dist/.\n";
const NOTES = "# Notes\n\nThe column mapping lives in schema.sql.\n";

const canCreateFileSymlink = (() => {
  const root = mkdtempSync(join(tmpdir(), "clarvis-memory-symlink-probe-"));
  try {
    const target = join(root, "target");
    writeFileSync(target, "probe");
    symlinkSync(target, join(root, "link"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

describe("createFileMemoryProvider", () => {
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "clarvis-fileprov-"));
    mkdirSync(join(ws, "docs"), { recursive: true });
    writeFileSync(join(ws, "docs", "constitution.md"), DOCTRINE);
    writeFileSync(join(ws, "NOTES.md"), NOTES);
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  const providerOf = (paths: string[]) => createFileMemoryProvider({ workspaceRoot: ws, paths });

  const call = async (paths: string[], tool: string, args: Record<string, unknown> = {}) => {
    const provider = providerOf(paths);
    const def = provider.readTools.find((t) => t.name === tool)!;
    return def.execute(args);
  };

  it("declares the read half and no write half at all", () => {
    const provider = providerOf(["NOTES.md"]);
    expect(provider.kind).toBe(FILE_PROVIDER_KIND);
    expect(provider.readTools.map((t) => t.name).sort()).toEqual(
      [...MEMORY_READ_TOOL_NAMES].sort(),
    );
    expect(provider.writeTools).toBeUndefined();
  });

  it("lists declared documents, marking the ones that are not there", async () => {
    const res = await call(["docs/constitution.md", "missing.md"], "list_memories");
    expect(res.isError).toBe(false);
    expect(res.text).toContain("docs/constitution.md");
    expect(res.text).toContain("missing.md (not present)");
  });

  it("reads a declared document by its listed path", async () => {
    const res = await call(["docs/constitution.md"], "read_memory", {
      paths: ["docs/constitution.md"],
    });
    expect(res).toEqual({ text: `## docs/constitution.md\n${DOCTRINE}`, isError: false });
  });

  it("refuses a path that was never declared, pointing at list_memories", async () => {
    const res = await call(["NOTES.md"], "read_memory", { paths: ["/etc/passwd"] });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("not found");
  });

  it("reports a declared but absent document as an error, not as empty content", async () => {
    const res = await call(["gone.md"], "read_memory", { paths: ["gone.md"] });
    expect(res).toEqual({ text: "## gone.md\n(not found)", isError: false });
  });

  it("greps across every declared document with path and line number", async () => {
    const res = await call(["docs/constitution.md", "NOTES.md"], "grep_memories", {
      query: "column mapping",
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("NOTES.md:3:");
  });

  it("reports no matches rather than failing", async () => {
    const res = await call(["NOTES.md"], "grep_memories", { query: "nothing here" });
    expect(res).toEqual({ text: "no matches", isError: false });
  });

  it("honours the canonical regex flag", async () => {
    const res = await call(["NOTES.md"], "grep_memories", {
      query: "column\\s+mapping",
      regex: true,
    });
    expect(res.text).toContain("NOTES.md:3:");
  });

  it("rejects an empty grep query", async () => {
    const res = await call(["NOTES.md"], "grep_memories", { query: "  " });
    expect(res.isError).toBe(true);
  });

  it("ranks documents by how many query terms they carry", async () => {
    const res = await call(["docs/constitution.md", "NOTES.md"], "query_memories", {
      query: "where is the column mapping",
    });
    expect(res.isError).toBe(false);
    expect(res.text.indexOf("NOTES.md")).toBeLessThan(
      res.text.indexOf("docs/constitution.md") === -1 ? Infinity : res.text.indexOf("docs/"),
    );
  });

  it("says so plainly when nothing is relevant", async () => {
    const res = await call(["NOTES.md"], "query_memories", { query: "kubernetes ingress" });
    expect(res.text).toContain("no relevant documents");
  });

  it("rejects a declaration above the provider path cap", () => {
    expect(() =>
      createFileMemoryProvider({
        workspaceRoot: ws,
        paths: Array.from({ length: 65 }, (_, index) => `doc-${String(index)}.md`),
      }),
    ).toThrow(/64-path limit/);
  });

  it("does not let allocation overrides bypass the package hard limits", () => {
    expect(() =>
      createFileMemoryProvider({
        workspaceRoot: ws,
        paths: ["NOTES.md"],
        maxDocumentBytes: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/maxDocumentBytes/);
    expect(() =>
      createFileMemoryProvider({
        workspaceRoot: ws,
        paths: ["NOTES.md"],
        maxAggregateBytes: 33 * 1024 * 1024,
      }),
    ).toThrow(/maxAggregateBytes/);
  });

  it("does not materialize an oversized document and marks the answer incomplete", async () => {
    const provider = createFileMemoryProvider({
      workspaceRoot: ws,
      paths: ["NOTES.md"],
      maxDocumentBytes: 16,
    });
    const tool = provider.readTools.find((candidate) => candidate.name === "read_memory")!;

    const result = await tool.execute({ paths: ["NOTES.md"] });

    expect(result.text).toContain("(not found)");
    expect(result.text).toContain("read incomplete");
    expect(result.text).not.toContain("column mapping");
  });

  describe("seed", () => {
    it("concatenates present documents in declared order as raw content", async () => {
      const block = await providerOf(["docs/constitution.md", "NOTES.md"]).seed();
      expect(block).not.toBeNull();
      expect(block).not.toContain("<memory>");
      expect(block!.indexOf("## docs/constitution.md")).toBeLessThan(block!.indexOf("## NOTES.md"));
    });

    it("is null when nothing declared is present, so no empty block is injected", async () => {
      await expect(providerOf(["nope.md"]).seed()).resolves.toBeNull();
    });

    it("tolerates a declared path that cannot be read", async () => {
      const block = await providerOf(["docs", "NOTES.md"]).seed();
      expect(block).toContain("## NOTES.md");
      expect(block).not.toContain("## docs\n");
    });
  });

  describe("confinement", () => {
    it("treats a workspace that disappeared before reading as an empty provider", async () => {
      const missingRoot = join(ws, "gone");
      const provider = createFileMemoryProvider({ workspaceRoot: missingRoot, paths: ["note.md"] });

      const result = await provider.readTools
        .find((candidate) => candidate.name === "list_memories")!
        .execute({});

      expect(result.text).toContain("note.md (not present)");
    });

    it("never reads outside the workspace, however the path is written", async () => {
      writeFileSync(join(ws, "..", "outside-marker.md"), "secret");
      for (const escape of ["../outside-marker.md", "docs/../../outside-marker.md"]) {
        const res = await call([escape], "read_memory", { paths: [escape] });
        expect(res.text).toContain("not found");
      }
      rmSync(join(ws, "..", "outside-marker.md"), { force: true });
    });

    it("rejects an absolute path even when it points inside the workspace", async () => {
      const abs = join(ws, "NOTES.md");
      const res = await call([abs], "read_memory", { paths: [abs] });
      expect(res.text).toContain("not found");
    });

    it.skipIf(!canCreateFileSymlink)(
      "does not follow a declared resource symlink outside the workspace",
      async () => {
        const outside = join(ws, "..", "outside-memory.md");
        writeFileSync(outside, "secret outside memory");
        symlinkSync(outside, join(ws, "linked.md"));
        try {
          const res = await call(["linked.md"], "read_memory", { paths: ["linked.md"] });
          expect(res.text).toContain("(not found)");
          expect(res.text).not.toContain("secret outside memory");
        } finally {
          rmSync(outside, { force: true });
        }
      },
    );
  });
});
