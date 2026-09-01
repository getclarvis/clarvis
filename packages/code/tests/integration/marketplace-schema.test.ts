import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { marketplaceSchema, type Marketplace } from "@clarvis/kernel/config";

const happy = {
  name: "clarvis community",
  description: "Community plugins.",
  plugins: [
    { name: "reviewkit", source: "https://github.com/o/reviewkit", description: "Review helpers." },
  ],
};

/** Parse a document the way the marketplace adapter does, failing loudly if it will not parse. */
function read(document: unknown): Marketplace {
  const parsed = marketplaceSchema.safeParse(document);
  if (!parsed.success) throw new Error(`expected a readable catalog: ${parsed.error.message}`);
  return parsed.data;
}

/** The committed catalog written in another agent host's dialect. */
function foreignCatalog(): unknown {
  const file = join(import.meta.dir, "..", "fixtures", "marketplaces", "foreign-dialect.json");
  return JSON.parse(readFileSync(file, "utf8"));
}

test("marketplaceSchema: accepts a canonical marketplace unchanged", () => {
  const catalog = read(happy);
  expect(catalog.name).toBe("clarvis community");
  expect(catalog.notes).toEqual([]);
  expect(catalog.plugins).toHaveLength(1);
  expect(catalog.plugins[0]!.installable).toBe(true);
  expect(catalog.plugins[0]!.notes).toEqual([]);
});

test("marketplaceSchema: accepts an empty catalog", () => {
  expect(read({ name: "empty", plugins: [] }).plugins).toEqual([]);
});

test("marketplaceSchema: refuses only a document that is not an object at all", () => {
  for (const document of [null, 7, "text", [happy]]) {
    expect(marketplaceSchema.safeParse(document).success).toBe(false);
  }
});

test("marketplaceSchema: an unknown root key is a note, not a rejection", () => {
  const catalog = read({ ...happy, bogus: 1 });
  expect(catalog.plugins).toHaveLength(1);
  expect(catalog.notes.join(" ")).toContain("keys Clarvis does not act on: bogus");
});

test("marketplaceSchema: an unknown listing key is a note on that listing only", () => {
  const catalog = read({ ...happy, plugins: [{ ...happy.plugins[0], sneaky: true }] });
  expect(catalog.plugins).toHaveLength(1);
  expect(catalog.plugins[0]!.notes.join(" ")).toContain("keys Clarvis does not act on: sneaky");
  expect(catalog.notes).toEqual([]);
});

test("marketplaceSchema: a near-miss key is reported as the misspelling it is", () => {
  const catalog = read({ ...happy, plugins: [{ ...happy.plugins[0], homepag: "https://h" }] });
  expect(catalog.plugins[0]!.notes.join(" ")).toContain("looks like a misspelling of 'homepage'");
});

test("marketplaceSchema: a listing cannot smuggle hooks or servers — it is a pointer only", () => {
  const catalog = read({
    ...happy,
    plugins: [{ ...happy.plugins[0], hooks: [{ event: "pre_tool_use", command: "x" }] }],
  });
  const listing = catalog.plugins[0]!;
  expect(Object.keys(listing)).not.toContain("hooks");
  expect(listing.notes.join(" ")).toContain("hooks");
});

test("marketplaceSchema: a listing whose name could spoof a namespace is dropped, not the catalog", () => {
  for (const name of ["has:colon", "has/slash", "..", "Upper"]) {
    const catalog = read({
      ...happy,
      plugins: [
        { ...happy.plugins[0], name },
        { ...happy.plugins[0], name: "survivor" },
      ],
    });
    expect(catalog.plugins.map((p) => p.name)).toEqual(["survivor"]);
    expect(catalog.notes.join(" ")).toContain("was dropped");
  }
});

test("marketplaceSchema: accepts an optional subdir path for a multi-plugin repo", () => {
  const catalog = read({ ...happy, plugins: [{ ...happy.plugins[0], path: "plugins/reviewkit" }] });
  expect(catalog.plugins[0]!.path).toBe("plugins/reviewkit");
});

test("marketplaceSchema: a path that escapes the repo bars that listing from install alone", () => {
  for (const path of ["../evil", "plugins/../../etc", "/abs/path", "plugins\\win"]) {
    const catalog = read({
      ...happy,
      plugins: [
        { ...happy.plugins[0], name: "escaper", path },
        { ...happy.plugins[0], name: "survivor" },
      ],
    });
    const escaper = catalog.plugins.find((p) => p.name === "escaper");
    const survivor = catalog.plugins.find((p) => p.name === "survivor");

    expect(escaper?.installable).toBe(false);
    expect(escaper?.path).toBeUndefined();
    expect(escaper?.notes.join(" ")).toContain("cannot be installed from here");
    expect(survivor?.installable).toBe(true);
  }
});

test("marketplaceSchema: a listing with no source is dropped — nothing can resolve it", () => {
  const catalog = read({ ...happy, plugins: [{ name: "x", description: "d" }] });
  expect(catalog.plugins).toEqual([]);
  expect(catalog.notes.join(" ")).toContain("'source'");
});

test("marketplaceSchema: a listing with no description keeps its place and is given one", () => {
  const catalog = read({
    ...happy,
    plugins: [{ name: "x", source: "https://h/x", category: "writing" }],
  });
  expect(catalog.plugins).toHaveLength(1);
  expect(catalog.plugins[0]!.description).toContain("writing");
  expect(catalog.plugins[0]!.notes.join(" ")).toContain("no description was authored");
});

test("marketplaceSchema: a document with no name is given one rather than refused", () => {
  const catalog = read({ plugins: [] });
  expect(catalog.name.length).toBeGreaterThan(0);
  expect(catalog.notes.join(" ")).toContain("no name was authored");
});

test("marketplaceSchema: a document with no plugins array reads as an empty catalog", () => {
  expect(read({ name: "x" }).plugins).toEqual([]);
  const wrongType = read({ name: "x", plugins: "everything" });
  expect(wrongType.plugins).toEqual([]);
  expect(wrongType.notes.join(" ")).toContain("must be an array");
});

test("marketplaceSchema: a listing that is not an object is dropped, and its siblings survive", () => {
  const catalog = read({ ...happy, plugins: [42, ...happy.plugins] });
  expect(catalog.plugins.map((p) => p.name)).toEqual(["reviewkit"]);
  expect(catalog.notes.join(" ")).toContain("a listing must be an object");
});

test("marketplaceSchema: an oversized catalog is truncated with a note, never refused", () => {
  const many = Array.from({ length: 1_001 }, (_, i) => ({
    name: `p${String(i)}`,
    source: "https://h/x",
    description: "d",
  }));
  const catalog = read({ name: "big", plugins: many });
  expect(catalog.plugins).toHaveLength(1_000);
  expect(catalog.notes.join(" ")).toContain("only the first 1000");
});

test("marketplaceSchema: a confined relative-path source is installable", () => {
  const catalog = read({
    ...happy,
    plugins: [{ name: "beside", source: "./plugins/beside", description: "d" }],
  });
  expect(catalog.plugins[0]!.sourceType).toBe("local");
  expect(catalog.plugins[0]!.installable).toBe(true);
});

test("marketplaceSchema: an object source descriptor parses and names its path", () => {
  const catalog = read({
    ...happy,
    plugins: [
      { name: "beside", source: { source: "local", path: "./plugins/beside" }, description: "d" },
    ],
  });
  expect(catalog.plugins[0]!.source).toBe("./plugins/beside");
  expect(catalog.plugins[0]!.installable).toBe(true);
});

test("marketplaceSchema: a source kind with no fetcher degrades the listing, it does not throw", () => {
  const catalog = read({
    ...happy,
    plugins: [{ name: "elsewhere", source: { source: "registry" }, description: "d" }],
  });
  expect(catalog.plugins).toHaveLength(1);
  expect(catalog.plugins[0]!.installable).toBe(false);
  expect(catalog.plugins[0]!.notes.join(" ")).toContain("no fetcher for");
});

test("marketplaceSchema: a local source with no path is still read, and still not installable", () => {
  const catalog = read({
    ...happy,
    plugins: [{ name: "beside", source: { source: "local" }, description: "d" }],
  });
  expect(catalog.plugins[0]!.installable).toBe(false);
  expect(catalog.plugins[0]!.notes.join(" ")).toContain("no path");
});

test("marketplaceSchema: a local source that would escape its root is named as such", () => {
  const catalog = read({
    ...happy,
    plugins: [
      { name: "beside", source: { source: "local", path: "../outside" }, description: "d" },
      { name: "loose", source: "../outside", description: "d" },
    ],
  });
  for (const listing of catalog.plugins) {
    expect(listing.installable).toBe(false);
    expect(listing.notes.join(" ")).toContain("outside the marketplace root");
  }
});

test("marketplaceSchema: ssh and transport sources stay installable", () => {
  const catalog = read({
    ...happy,
    plugins: [
      { name: "a", source: "git@example.invalid:o/a.git", description: "d" },
      { name: "b", source: "ssh://git@example.invalid/o/b.git", description: "d" },
      { name: "c", source: "file:///tmp/c", description: "d" },
    ],
  });
  expect(catalog.plugins.every((p) => p.installable)).toBe(true);
});

test("the committed foreign-dialect catalog parses, and loses no listing", () => {
  const catalog = read(foreignCatalog());
  expect(catalog.name).toBe("example-catalog");
  expect(catalog.plugins.map((p) => p.name)).toEqual([
    "reviewkit",
    "notekeeper",
    "shipper",
    "fetcher",
    "docs",
  ]);
  expect(catalog.notes.join(" ")).not.toContain("was dropped");
});

test("the foreign catalog's root presentation block is reported, never acted on", () => {
  const notes = read(foreignCatalog()).notes.join(" ");
  expect(notes).toContain("keys Clarvis does not act on: metadata, owner");
});

test("reads a foreign entry's policy block and its presentation", () => {
  const catalog = read(foreignCatalog());
  const reviewkit = catalog.plugins.find((p) => p.name === "reviewkit")!;
  const notes = reviewkit.notes.join(" ");

  expect(reviewkit.installation).toBe("AVAILABLE");
  expect(notes).not.toContain("does not act on: interface");
});

test("a foreign listing with no description keeps its place, taking its summary or its category", () => {
  const catalog = read(foreignCatalog());
  const reviewkit = catalog.plugins.find((p) => p.name === "reviewkit")!;
  expect(reviewkit.description).toBe("Structured review passes over a diff.");
  expect(reviewkit.displayName).toBe("Review Kit");
  expect(reviewkit.notes.join(" ")).toContain("read its summary instead");

  const notekeeper = catalog.plugins.find((p) => p.name === "notekeeper")!;
  expect(notekeeper.description).toContain("writing");
  expect(notekeeper.notes.join(" ")).toContain("Clarvis supplied one");

  const shipper = catalog.plugins.find((p) => p.name === "shipper")!;
  expect(shipper.description).toBe("Release checklists.");
  expect(shipper.displayName).toBe("Shipper");
});

test("the foreign catalog's git-backed and confined local listings are installable", () => {
  const catalog = read(foreignCatalog());
  const installable = catalog.plugins.filter((p) => p.installable).map((p) => p.name);
  expect(installable).toEqual(["reviewkit", "notekeeper", "shipper", "docs"]);
});

test("the foreign catalog reads its categories as presentation, and nothing more", () => {
  const catalog = read(foreignCatalog());
  expect(catalog.plugins.find((p) => p.name === "notekeeper")!.category).toBe("writing");
  expect(catalog.plugins.find((p) => p.name === "notekeeper")!.installable).toBe(true);
});

test("corrupting one foreign listing costs exactly that listing", () => {
  const document = foreignCatalog() as { plugins: Record<string, unknown>[] };
  const intact = read(document).plugins.length;
  document.plugins[2] = { ...document.plugins[2], name: "NOT A NAME" };
  const catalog = read(document);
  expect(catalog.plugins).toHaveLength(intact - 1);
  expect(catalog.plugins.map((p) => p.name)).not.toContain("shipper");
  expect(catalog.notes.filter((n) => n.includes("was dropped"))).toHaveLength(1);
});

test("reads the catalog's own display name out of a nested presentation block", () => {
  const catalog = read({ ...happy, interface: { displayName: "Community catalog" } });

  expect(catalog.displayName).toBe("Community catalog");
});

test("stops calling a presentation block unacted-on once it has been read from", () => {
  const catalog = read({ ...happy, interface: { displayName: "Community catalog" } });

  expect(catalog.notes.join(" ")).not.toContain("interface");
});

test("still reports a presentation block holding nothing it can read", () => {
  const catalog = read({ ...happy, interface: { brandColor: "#3B82F6" } });

  expect(catalog.displayName).toBeUndefined();
  expect(catalog.notes.join(" ")).toContain("interface");
});

test("prefers a display name written at the top level over a nested one", () => {
  const catalog = read({
    ...happy,
    displayName: "Top level",
    interface: { displayName: "Nested" },
  });

  expect(catalog.displayName).toBe("Top level");
});

test("does not report a top-level display name as a key it does not act on", () => {
  const catalog = read({ ...happy, displayName: "ACME Catalog" });

  expect(catalog.displayName).toBe("ACME Catalog");
  expect(catalog.notes).toEqual([]);
});

test("does not report the key a listing's description was borrowed from", () => {
  const catalog = read({
    name: "acme",
    plugins: [{ name: "docs", source: "https://github.com/o/docs", summary: "one line" }],
  });

  const notes = catalog.plugins[0]!.notes.join(" ");
  expect(catalog.plugins[0]!.description).toBe("one line");
  expect(notes).toContain("read its summary instead");
  expect(notes).not.toContain("does not act on");
});

test("bounds a listing's notes, in count and in the length of any one of them", () => {
  const listing: Record<string, unknown> = {
    name: "docs",
    source: "https://github.com/o/docs",
    description: "d",
  };
  for (let i = 0; i < 3000; i++) listing[`nam${String(i)}`] = 1;

  const catalog = read({ name: "acme", plugins: [listing] });

  const notes = catalog.plugins[0]!.notes;
  expect(notes.length).toBeLessThanOrEqual(41);
  expect(Math.max(...notes.map((n) => n.length))).toBeLessThan(1000);
});

test("keeps a listing whose path escapes its source, but refuses to install it", () => {
  const catalog = read({
    name: "acme",
    plugins: [
      { name: "docs", source: "https://github.com/o/docs", description: "d", path: "../x" },
    ],
  });

  expect(catalog.plugins).toHaveLength(1);
  expect(catalog.plugins[0]!.installable).toBe(false);
  expect(catalog.plugins[0]!.path).toBeUndefined();
  expect(catalog.plugins[0]!.notes.join(" ")).toContain("cannot be installed from here");
});
