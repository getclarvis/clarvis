import { beforeEach, describe, expect, test } from "bun:test";

import { reindex } from "../../src/reindex.ts";
import { createInMemoryMemoryStore } from "../../src/testing.ts";
import { createMemoryTools } from "../../src/tools.ts";
import type { MemoryStore, MemoryToolDef } from "../../src/types.ts";

describe("memory tools", () => {
  let store: MemoryStore;
  let tools: Record<string, MemoryToolDef>;

  beforeEach(() => {
    store = createInMemoryMemoryStore();
    const list = createMemoryTools({ store, reindex: (tx) => reindex(tx) });
    tools = Object.fromEntries(list.map((t) => [t.name, t]));
  });

  test("exposes the wiki tools", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "delete_memory",
      "edit_memory",
      "grep_memories",
      "list_memories",
      "query_memories",
      "read_memory",
      "write_memory",
    ]);
  });

  test("offers ranked search before literal search", () => {
    // Order is the recommendation: a model reads the list top-down, and
    // meaning-based lookup should be the default reach.
    const names = createMemoryTools({ store, reindex: (tx) => reindex(tx) }).map((t) => t.name);
    expect(names.indexOf("query_memories")).toBeLessThan(names.indexOf("grep_memories"));
  });

  test("write_memory persists the leaf and reindexes the navigation", async () => {
    const res = await tools.write_memory!.execute({
      path: "infra/bun/MEMORY.md",
      content: "---\ndescription: pinned via mise\n---\n# Bun",
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("reindexed");
    expect(await store.read("PROFILE.md")).toContain("[infra](infra/TOPIC.md)");
    expect(await store.read("infra/TOPIC.md")).toContain("[bun](bun/MEMORY.md) — pinned via mise");
  });

  test("write_memory warns when frontmatter has no description", async () => {
    const res = await tools.write_memory!.execute({
      path: "misc/a/MEMORY.md",
      content: "# no frontmatter",
    });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("no `description:`");
  });

  test("read_memory returns full bodies and marks missing paths", async () => {
    await store.write("misc/a/MEMORY.md", "hello world");
    const res = await tools.read_memory!.execute({
      paths: ["misc/a/MEMORY.md", "misc/gone/MEMORY.md"],
    });
    expect(res.text).toContain("hello world");
    expect(res.text).toContain("(not found)");
  });

  test("list_memories shows path, kind and description", async () => {
    await tools.write_memory!.execute({
      path: "infra/bun/MEMORY.md",
      content: "---\ndescription: bun facts\n---\n# B",
    });
    const res = await tools.list_memories!.execute({});
    expect(res.text).toContain("infra/bun/MEMORY.md · memory · bun facts");
    const filtered = await tools.list_memories!.execute({ prefix: "nowhere/" });
    expect(filtered.text).toContain("No memory documents");
  });

  test("query_memories explains empty, absent, and ranked results", async () => {
    expect((await tools.query_memories!.execute({ query: "the and" })).text).toContain(
      "no searchable terms",
    );
    expect((await tools.query_memories!.execute({ query: "kubernetes ingress" })).text).toContain(
      "No relevant documents",
    );
    await store.write(
      "infra/bun/MEMORY.md",
      "---\ndescription: Bun runtime\n---\n# Bun\n\nPinned with mise.\n",
    );
    const ranked = await tools.query_memories!.execute({ query: "bun mise" });
    expect(ranked.text).toContain("infra/bun/MEMORY.md");
    expect(ranked.text).toContain("Bun runtime");
    expect(ranked.text).toContain("Pinned with mise");
  });

  test("edit_memory replaces a unique substring and rejects ambiguity", async () => {
    await store.write("misc/a/MEMORY.md", "---\ndescription: d\n---\nalpha beta alpha");
    const dup = await tools.edit_memory!.execute({
      path: "misc/a/MEMORY.md",
      old_string: "alpha",
      new_string: "gamma",
    });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain("2×");

    const ok = await tools.edit_memory!.execute({
      path: "misc/a/MEMORY.md",
      old_string: "beta",
      new_string: "delta",
    });
    expect(ok.isError).toBe(false);
    expect(await store.read("misc/a/MEMORY.md")).toContain("alpha delta alpha");
  });

  test("delete_memory removes the leaf and reports a missing one", async () => {
    await store.write("misc/a/MEMORY.md", "x");
    expect((await tools.delete_memory!.execute({ path: "misc/a/MEMORY.md" })).isError).toBe(false);
    expect(await store.read("misc/a/MEMORY.md")).toBeNull();
    expect((await tools.delete_memory!.execute({ path: "misc/a/MEMORY.md" })).isError).toBe(true);
  });

  test("a traversal path comes back as an error result, never throwing", async () => {
    const res = await tools.write_memory!.execute({ path: "../evil.md", content: "x" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/leaf path|relative/i);
  });

  test("mutation tools can compile PROFILE and TOPIC while reindex owns Contents", async () => {
    await store.write("infra/bun/MEMORY.md", "---\ndescription: Bun runtime\n---\n# Bun");
    const topic = await tools.write_memory!.execute({
      path: "infra/TOPIC.md",
      content:
        "---\ndescription: Runtime and package management\n---\n# Infrastructure\n\nUse Bun via mise.",
    });
    const profile = await tools.write_memory!.execute({
      path: "PROFILE.md",
      content:
        "---\ndescription: Workspace operational profile\n---\n# Operational profile\n\nThis is a Bun workspace.",
    });
    expect(topic.isError).toBe(false);
    expect(profile.isError).toBe(false);
    expect(await store.read("PROFILE.md")).toContain("This is a Bun workspace.");
    expect(await store.read("PROFILE.md")).toContain("## Contents");
    expect(await store.read("infra/TOPIC.md")).toContain("Use Bun via mise.");
    expect(await store.read("infra/TOPIC.md")).toContain("[bun](bun/MEMORY.md) — Bun runtime");
  });

  test("navigation restitching does not create user-facing document revisions", async () => {
    await tools.write_memory!.execute({
      path: "infra/bun/MEMORY.md",
      content: "---\ndescription: bun facts\n---\nfirst\n",
    });
    await tools.write_memory!.execute({
      path: "infra/bun/MEMORY.md",
      content: "---\ndescription: bun facts\n---\nsecond\n",
    });

    expect(await store.revisions.list("PROFILE.md")).toEqual([]);
    expect(await store.revisions.list("infra/TOPIC.md")).toEqual([]);
  });

  test("grep_memories returns path:line matches", async () => {
    await store.write("misc/a/MEMORY.md", "---\ndescription: d\n---\nthe answer is 42");
    const res = await tools.grep_memories!.execute({ query: "answer" });
    expect(res.text).toContain("a/MEMORY.md:");
    expect(res.text).toContain("42");
  });

  describe("owner-only authority markers", () => {
    const PLAIN = "---\ndescription: d\n---\n# T\n\nbody\n";

    test("write_memory refuses to create a document that pins itself", async () => {
      const res = await tools.write_memory!.execute({
        path: "infra/bun/MEMORY.md",
        content: "---\ndescription: d\npinned: true\n---\n# Bun\n",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("pin");
      expect(await store.read("infra/bun/MEMORY.md")).toBeNull();
    });

    test("write_memory refuses to create a document that marks itself confirmed", async () => {
      const res = await tools.write_memory!.execute({
        path: "infra/bun/MEMORY.md",
        content: "---\ndescription: d\nauthority: confirmed\n---\n# Bun\n",
      });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("confirmed");
      expect(await store.read("infra/bun/MEMORY.md")).toBeNull();
    });

    test("edit_memory cannot smuggle either marker in through a substring edit", async () => {
      for (const injected of ["pinned: true", "authority: confirmed"]) {
        await store.write("misc/a/MEMORY.md", PLAIN);
        const res = await tools.edit_memory!.execute({
          path: "misc/a/MEMORY.md",
          old_string: "description: d",
          new_string: `description: d\n${injected}`,
        });
        expect(res.isError).toBe(true);
        expect(await store.read("misc/a/MEMORY.md")).toBe(PLAIN);
      }
    });

    test("edit_memory cannot take the owner's pin back off", async () => {
      // The two-call bypass: unpin by edit, then replace wholesale.
      const doc = "---\ndescription: d\npinned: true\n---\n# T\n\nbody\n";
      await store.write("misc/a/MEMORY.md", doc);

      const unpin = await tools.edit_memory!.execute({
        path: "misc/a/MEMORY.md",
        old_string: "pinned: true\n",
        new_string: "",
      });

      expect(unpin.isError).toBe(true);
      expect(unpin.text).toContain("unpin");
      expect(await store.read("misc/a/MEMORY.md")).toBe(doc);
    });

    test("edit_memory cannot lose the pin by breaking the frontmatter block", async () => {
      // An unclosed block parses with no frontmatter at all, which would read
      // as an unpinned document on the next write.
      const doc = "---\ndescription: d\npinned: true\n---\n# T\n\nbody\n";
      await store.write("misc/a/MEMORY.md", doc);

      const res = await tools.edit_memory!.execute({
        path: "misc/a/MEMORY.md",
        old_string: "---\n# T",
        new_string: "# T",
      });

      expect(res.isError).toBe(true);
      expect(await store.read("misc/a/MEMORY.md")).toBe(doc);
    });

    test("a surgical edit to a pinned document still works", async () => {
      await store.write("misc/a/MEMORY.md", "---\ndescription: d\npinned: true\n---\n# T\n\n1.0\n");
      const res = await tools.edit_memory!.execute({
        path: "misc/a/MEMORY.md",
        old_string: "1.0",
        new_string: "1.3.14",
      });
      expect(res.isError).toBe(false);
      expect(await store.read("misc/a/MEMORY.md")).toContain("1.3.14");
      expect(await store.read("misc/a/MEMORY.md")).toContain("pinned: true");
    });

    test("write_memory may still replace a confirmed document that keeps the marker", async () => {
      // `confirmed` is a ranking signal, not a write barrier; only `pinned` is.
      const before = "---\ndescription: d\nauthority: confirmed\n---\n# T\n\nold\n";
      await store.write("misc/a/MEMORY.md", before);

      const res = await tools.write_memory!.execute({
        path: "misc/a/MEMORY.md",
        content: "---\ndescription: d\nauthority: confirmed\n---\n# T\n\nnew\n",
      });

      expect(res.isError).toBe(false);
      expect(await store.read("misc/a/MEMORY.md")).toContain("new");
    });
  });

  describe("derived parameter schemas", () => {
    test("every tool advertises a closed object schema with no $schema document key", () => {
      for (const tool of Object.values(tools)) {
        const params = tool.parameters;
        expect(params.type).toBe("object");
        expect(params.additionalProperties).toBe(false);
        expect(params).not.toHaveProperty("$schema");
        expect(typeof params.properties).toBe("object");
      }
    });

    test("marks exactly the fields zod requires as required", () => {
      // Derived from the same declaration that validates, so these cannot drift.
      expect(tools.read_memory!.parameters.required).toEqual(["paths"]);
      expect(tools.write_memory!.parameters.required).toEqual(["path", "content"]);
      expect(tools.edit_memory!.parameters.required).toEqual(["path", "old_string", "new_string"]);
      expect(tools.delete_memory!.parameters.required).toEqual(["path"]);
      // `prefix` is optional; `regex`/`limit` carry defaults.
      expect(tools.list_memories!.parameters.required).toBeUndefined();
      expect(tools.grep_memories!.parameters.required).toEqual(["query"]);
    });

    test("carries field constraints, defaults and descriptions through to the model", () => {
      const grep = tools.grep_memories!.parameters.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(grep.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 50, default: 20 });
      expect(grep.regex).toMatchObject({ type: "boolean", default: false });
      expect(grep.query!.description).toContain("regex");

      const read = tools.read_memory!.parameters.properties as Record<
        string,
        Record<string, unknown>
      >;
      expect(read.paths).toMatchObject({ type: "array", minItems: 1, maxItems: 5 });
    });

    test("still enforces refinements the JSON Schema cannot express", async () => {
      // `memoryLeafPathSchema` is a refinement, so it is absent from the
      // advertised schema but must still reject at execute time.
      const res = await tools.delete_memory!.execute({ path: "PROFILE.md" });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("Invalid arguments");
    });
  });
});
