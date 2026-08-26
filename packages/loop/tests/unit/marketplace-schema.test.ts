import { describe, it, expect } from "../bun-test.ts";
import {
  marketplaceSchema,
  type Marketplace,
  type MarketplaceEntry,
} from "../../src/settings/marketplace-schema.ts";

/** The two strings the reader supplies when a document authors neither. */
const DEFAULT_MARKETPLACE_NAME = "unnamed marketplace";
const DEFAULT_ENTRY_DESCRIPTION = "no description provided by this marketplace";

/** Why a listing naming a local source is read but never offered for install. */
const LOCAL_SOURCE_NOTE =
  "names a local source; Clarvis installs a plugin from git only, so this listing is " +
  "shown but cannot be installed from here";

/** The reader's own truncation bounds, restated so a change to one fails a test. */
const MAX_LISTINGS = 1_000;
const MAX_NOTES = 40;
const MAX_LISTED_KEYS = 20;

/** Parse a document, failing loudly when the reader refuses it outright. */
function read(document: unknown): Marketplace {
  const parsed = marketplaceSchema.safeParse(document);
  if (!parsed.success) throw new Error(`expected a readable catalog: ${parsed.error.message}`);
  return parsed.data;
}

/** A listing the reader has nothing to say about, with `over` layered on top. */
function listing(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "reviewkit", source: "https://github.com/o/reviewkit", description: "d", ...over };
}

/** Read a one-listing catalog and return that listing, failing loudly if it was dropped. */
function only(over: Record<string, unknown> = {}): MarketplaceEntry {
  const catalog = read({ name: "acme", plugins: [listing(over)] });
  const entry = catalog.plugins[0];
  if (entry === undefined) throw new Error(`listing was dropped: ${catalog.notes.join(" | ")}`);
  return entry;
}

/** Everything one listing had to say about itself, as one string. */
function entryNotes(over: Record<string, unknown> = {}): string {
  return only(over).notes.join("\n");
}

/** Everything the document had to say about itself, as one string. */
function docNotes(document: Record<string, unknown>): string {
  return read(document).notes.join("\n");
}

describe("marketplaceSchema: the document", () => {
  it("accepts a canonical catalog and has nothing to say about it", () => {
    const catalog = read({
      name: "clarvis community",
      description: "Community plugins.",
      displayName: "Clarvis Community",
      plugins: [listing()],
    });

    expect(catalog.name).toBe("clarvis community");
    expect(catalog.description).toBe("Community plugins.");
    expect(catalog.displayName).toBe("Clarvis Community");
    expect(catalog.notes).toEqual([]);
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0]).toEqual({
      name: "reviewkit",
      source: "https://github.com/o/reviewkit",
      description: "d",
      installable: true,
      notes: [],
    });
  });

  it("refuses only a document that is not an object at all", () => {
    for (const document of [null, undefined, 7, "text", true, [{ name: "a" }]]) {
      expect(marketplaceSchema.safeParse(document).success).toBe(false);
    }
    expect(marketplaceSchema.safeParse({}).success).toBe(true);
  });

  it("supplies the catalog name when the document authors none, and says so", () => {
    const catalog = read({ plugins: [] });

    expect(catalog.name).toBe(DEFAULT_MARKETPLACE_NAME);
    expect(catalog.notes).toEqual(["marketplace: no name was authored; Clarvis supplied one"]);
  });

  it("reports an unreadable name as ignored rather than as one nobody authored", () => {
    const notes = docNotes({ name: "", plugins: [] });

    expect(read({ name: "", plugins: [] }).name).toBe(DEFAULT_MARKETPLACE_NAME);
    expect(notes).toContain("marketplace: 'name' was ignored");
    expect(notes).not.toContain("no name was authored");
  });

  it("drops an unreadable description and keeps reading the rest", () => {
    const catalog = read({ name: "acme", description: 7, plugins: [listing()] });

    expect(catalog.description).toBeUndefined();
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.notes.join("\n")).toContain("marketplace: 'description' was ignored");
  });

  it("reads plugins only from an array, and names the shape it wanted", () => {
    expect(read({ name: "acme" }).plugins).toEqual([]);
    expect(read({ name: "acme" }).notes).toEqual([]);

    const wrongType = read({ name: "acme", plugins: "everything" });
    expect(wrongType.plugins).toEqual([]);
    expect(wrongType.notes.join("\n")).toContain(
      "marketplace: 'plugins' was ignored — it must be an array of listings",
    );
  });
});

describe("marketplaceSchema: a display name, in whatever dialect it was written", () => {
  it("reads a top-level displayName without reporting it as unacted-on", () => {
    const catalog = read({ name: "acme", displayName: "ACME Catalog", plugins: [] });

    expect(catalog.displayName).toBe("ACME Catalog");
    expect(catalog.notes).toEqual([]);
  });

  it("reads every alternate top-level spelling", () => {
    for (const key of ["displayName", "display_name", "title"]) {
      const catalog = read({ name: "acme", [key]: "Nice Name", plugins: [] });
      expect(catalog.displayName).toBe("Nice Name");
      expect(catalog.notes.join("\n")).not.toContain(key);
    }
  });

  it("reads one out of a nested presentation block, and stops calling that block unacted-on", () => {
    for (const block of ["interface", "presentation", "display", "metadata", "meta"]) {
      const catalog = read({ name: "acme", [block]: { title: "Nested Name" }, plugins: [] });
      expect(catalog.displayName).toBe("Nested Name");
      expect(catalog.notes.join("\n")).not.toContain(block);
    }
  });

  it("prefers a display name written at the top level over a nested one", () => {
    const catalog = read({
      name: "acme",
      displayName: "Top level",
      interface: { displayName: "Nested" },
      plugins: [],
    });

    expect(catalog.displayName).toBe("Top level");
    expect(catalog.notes.join("\n")).toContain("keys Clarvis does not act on: interface");
  });

  it("still reports a presentation block holding nothing it can read", () => {
    const catalog = read({ name: "acme", interface: { brandColor: "#3B82F6" }, plugins: [] });

    expect(catalog.displayName).toBeUndefined();
    expect(catalog.notes.join("\n")).toContain("keys Clarvis does not act on: interface");
  });

  it("falls back to an alternate spelling when the canonical one is unreadable", () => {
    const catalog = read({ name: "acme", displayName: 5, title: "Fallback", plugins: [] });
    const notes = catalog.notes.join("\n");

    expect(catalog.displayName).toBe("Fallback");
    expect(notes).toContain("marketplace: 'displayName' was ignored");
    expect(notes).not.toContain("does not act on: title");
  });

  it("looks inside no block that is not a plain object", () => {
    const catalog = read({
      name: "acme",
      presentation: null,
      display: 7,
      metadata: ["Nested Name"],
      plugins: [],
    });

    expect(catalog.displayName).toBeUndefined();
    expect(catalog.notes.join("\n")).toContain(
      "keys Clarvis does not act on: display, metadata, presentation",
    );
  });

  it("ignores an empty or whitespace-only candidate rather than reading it", () => {
    const catalog = read({ name: "acme", display_name: "   ", title: "Real Name", plugins: [] });

    expect(catalog.displayName).toBe("Real Name");
  });
});

describe("marketplaceSchema: one listing, tolerated or dropped", () => {
  it("drops a listing that is not an object and keeps every sibling, naming its position", () => {
    const catalog = read({ name: "acme", plugins: [42, null, ["x"], "text", listing()] });

    expect(catalog.plugins.map((entry) => entry.name)).toEqual(["reviewkit"]);
    for (const position of [1, 2, 3, 4]) {
      expect(catalog.notes.join("\n")).toContain(
        `listing ${String(position)} was dropped: a listing must be an object`,
      );
    }
  });

  it("drops a listing with no usable name, naming it by position", () => {
    const catalog = read({ name: "acme", plugins: [{ source: "https://h/x" }, listing()] });

    expect(catalog.plugins.map((entry) => entry.name)).toEqual(["reviewkit"]);
    expect(catalog.notes.join("\n")).toContain("listing 1 was dropped: 'name'");
  });

  it("drops a name that could spoof a namespace or corrupt the trust map", () => {
    for (const name of ["has:colon", "has/slash", "..", "Upper", "has space", "__proto__", ""]) {
      const catalog = read({ name: "acme", plugins: [{ name, source: "https://h/x" }, listing()] });
      expect(catalog.plugins.map((entry) => entry.name)).toEqual(["reviewkit"]);
      expect(catalog.notes.join("\n")).toContain("was dropped: 'name'");
    }
  });

  it("drops a listing whose source cannot be resolved at all, naming it by name", () => {
    for (const source of [undefined, "", 7, {}, { path: "x" }, { source: "local", path: "" }]) {
      const catalog = read({ name: "acme", plugins: [{ name: "orphan", source }] });
      expect(catalog.plugins).toEqual([]);
      expect(catalog.notes.join("\n")).toContain("listing 'orphan' was dropped: 'source'");
    }
  });

  it("never drops a listing over a field it can simply ignore", () => {
    const entry = only({ homepage: "", category: 7, displayName: [], description: 9 });
    const notes = entry.notes.join("\n");

    expect(entry.homepage).toBeUndefined();
    expect(entry.category).toBeUndefined();
    expect(entry.displayName).toBeUndefined();
    expect(entry.installable).toBe(true);
    for (const field of ["homepage", "category", "displayName", "description"]) {
      expect(notes).toContain(`listing 'reviewkit': '${field}' was ignored`);
    }
  });

  it("reads the presentation fields a well-formed listing does author", () => {
    const entry = only({ homepage: "https://h", category: "review", displayName: "Review Kit" });

    expect(entry.homepage).toBe("https://h");
    expect(entry.category).toBe("review");
    expect(entry.displayName).toBe("Review Kit");
    expect(entry.notes).toEqual([]);
  });

  it("carries no key it was not asked to carry — a listing is a pointer, never a grant", () => {
    const entry = only({ hooks: [{ event: "pre_tool_use", command: "rm -rf /" }], guard: "off" });

    expect(Object.keys(entry).sort()).toEqual([
      "description",
      "installable",
      "name",
      "notes",
      "source",
    ]);
    expect(entry.notes.join("\n")).toContain("keys Clarvis does not act on: guard, hooks");
  });
});

describe("marketplaceSchema: a source, read in each dialect a catalog writes it in", () => {
  it("keeps a bare source carrying an explicit transport installable", () => {
    for (const source of [
      "https://github.com/o/a.git",
      "http://example.invalid/a",
      "ssh://git@example.invalid/o/b.git",
      "file:///tmp/c",
      "git+ssh://git@example.invalid/o/d.git",
    ]) {
      const entry = only({ source });
      expect(entry.installable).toBe(true);
      expect(entry.source).toBe(source);
      expect(entry.notes).toEqual([]);
    }
  });

  it("keeps a bare scp-style ssh source installable, trimming what surrounds it", () => {
    const entry = only({ source: "  git@example.invalid:o/a.git  " });

    expect(entry.installable).toBe(true);
    expect(entry.source).toBe("git@example.invalid:o/a.git");
  });

  it("reads a bare relative source but never offers it for install", () => {
    const entry = only({ name: "beside", source: "./plugins/beside" });

    expect(entry.source).toBe("./plugins/beside");
    expect(entry.installable).toBe(false);
    expect(entry.notes).toEqual([`listing 'beside' ${LOCAL_SOURCE_NOTE}`]);
  });

  it("names a bare source that would resolve outside the marketplace root", () => {
    for (const source of ["../outside", "plugins/../../etc", "/etc/passwd", "win\\path"]) {
      const entry = only({ name: "escaper", source });
      expect(entry.installable).toBe(false);
      expect(entry.source).toBe(source);
      expect(entry.notes.join("\n")).toContain(
        "listing 'escaper' names a local source that would resolve outside the marketplace root",
      );
    }
  });

  it("reads a `local` descriptor, case-insensitively, and never offers it for install", () => {
    for (const kind of ["local", "LOCAL", "  Local  "]) {
      const entry = only({ name: "beside", source: { source: kind, path: "  plugins/beside  " } });
      expect(entry.source).toBe("plugins/beside");
      expect(entry.installable).toBe(false);
      expect(entry.notes).toEqual([`listing 'beside' ${LOCAL_SOURCE_NOTE}`]);
    }
  });

  it("reads a `local` descriptor with no path, and says that is what it found", () => {
    const entry = only({ name: "beside", source: { source: "local" } });

    expect(entry.source).toBe("local");
    expect(entry.installable).toBe(false);
    expect(entry.notes).toEqual(["listing 'beside' names a local source with no path"]);
  });

  it("names a `local` descriptor whose path would escape the marketplace root", () => {
    const entry = only({ name: "beside", source: { source: "local", path: "../outside" } });

    expect(entry.source).toBe("../outside");
    expect(entry.installable).toBe(false);
    expect(entry.notes.join("\n")).toContain("outside the marketplace root");
  });

  it("degrades a source kind it has no fetcher for, with or without a path", () => {
    const bare = only({ name: "elsewhere", source: { source: "registry" } });
    expect(bare.source).toBe("registry");
    expect(bare.installable).toBe(false);
    expect(bare.notes).toEqual([
      "listing 'elsewhere' names source kind 'registry', which Clarvis has no fetcher for",
    ]);

    const withPath = only({ name: "elsewhere", source: { source: "npm", path: "@scope/pkg" } });
    expect(withPath.source).toBe("@scope/pkg");
    expect(withPath.installable).toBe(false);
    expect(withPath.notes.join("\n")).toContain("names source kind 'npm'");
  });

  it("carries a descriptor's extra keys without failing over them", () => {
    const entry = only({ name: "beside", source: { source: "local", path: "a", ref: "main" } });

    expect(entry.source).toBe("a");
    expect(entry.notes).toEqual([`listing 'beside' ${LOCAL_SOURCE_NOTE}`]);
  });
});

describe("marketplaceSchema: a listing's subdirectory path", () => {
  it("accepts a relative subdirectory, so one source can ship several plugins", () => {
    const entry = only({ path: "plugins/reviewkit" });

    expect(entry.path).toBe("plugins/reviewkit");
    expect(entry.installable).toBe(true);
    expect(entry.notes).toEqual([]);
  });

  it("bars install over a path it cannot read, but keeps the listing", () => {
    for (const path of ["../evil", "plugins/../../etc", "/abs/path", "plugins\\win", "", 7]) {
      const entry = only({ path });
      expect(entry.path).toBeUndefined();
      expect(entry.installable).toBe(false);
      expect(entry.notes.join("\n")).toContain("listing 'reviewkit': 'path' was ignored");
      expect(entry.notes.join("\n")).toContain(
        "listing 'reviewkit': its 'path' could not be read, so this listing is shown but cannot " +
          "be installed from here",
      );
    }
  });

  it("says nothing about a path the listing never authored", () => {
    expect(entryNotes()).not.toContain("'path'");
  });
});

describe("marketplaceSchema: a listing's description, supplied or borrowed", () => {
  it("supplies the exact default when nothing at all was authored", () => {
    const entry = only({ description: undefined });

    expect(entry.description).toBe(DEFAULT_ENTRY_DESCRIPTION);
    expect(entry.notes).toEqual([
      "listing 'reviewkit': no description was authored; Clarvis supplied one",
    ]);
  });

  it("names the listing's category in the description it supplies", () => {
    const entry = only({ description: undefined, category: "writing" });

    expect(entry.description).toBe(`${DEFAULT_ENTRY_DESCRIPTION} (category: writing)`);
    expect(entry.category).toBe("writing");
  });

  it("borrows a one-line summary written under any spelling, and says it borrowed", () => {
    for (const key of ["shortDescription", "short_description", "summary", "tagline"]) {
      const entry = only({ description: undefined, [key]: "Structured review passes." });
      expect(entry.description).toBe("Structured review passes.");
      expect(entry.notes).toEqual([
        "listing 'reviewkit': no description was authored; Clarvis read its summary instead",
      ]);
    }
  });

  it("borrows a summary out of a nested block, and stops calling that block unacted-on", () => {
    const entry = only({
      description: undefined,
      presentation: null,
      display: 7,
      metadata: [],
      meta: { summary: "Borrowed from a block." },
    });
    const notes = entry.notes.join("\n");

    expect(entry.description).toBe("Borrowed from a block.");
    expect(notes).toContain("read its summary instead");
    expect(notes).toContain("keys Clarvis does not act on: display, metadata, presentation");
    expect(notes).not.toContain("meta,");
  });

  it("ignores an unreadable description and then supplies one, reporting both", () => {
    const notes = entryNotes({ description: "" });

    expect(only({ description: "" }).description).toBe(DEFAULT_ENTRY_DESCRIPTION);
    expect(notes).toContain("listing 'reviewkit': 'description' was ignored");
    expect(notes).toContain("no description was authored; Clarvis supplied one");
  });
});

describe("marketplaceSchema: keys it does not act on, and the typos among them", () => {
  it("names every unrecognized key, sorted, at both levels", () => {
    expect(docNotes({ name: "acme", zebra: 1, alpha: 2, plugins: [] })).toContain(
      "marketplace: keys Clarvis does not act on: alpha, zebra",
    );
    expect(entryNotes({ zebra: 1, alpha: 2 })).toContain(
      "listing 'reviewkit': keys Clarvis does not act on: alpha, zebra",
    );
  });

  it("keeps a listing's foreign keys off the document's own note", () => {
    const catalog = read({ name: "acme", plugins: [listing({ sneaky: true })] });

    expect(catalog.notes).toEqual([]);
    expect(catalog.plugins[0]!.notes.join("\n")).toContain("does not act on: sneaky");
  });

  it("reports a near-miss root key as the misspelling it is", () => {
    for (const [typo, meant] of [
      ["plugin", "plugins"],
      ["descriptions", "description"],
      ["displayname", "displayName"],
    ] as const) {
      expect(docNotes({ name: "acme", [typo]: "x", plugins: [] })).toContain(
        `marketplace: '${typo}' looks like a misspelling of '${meant}'`,
      );
    }
  });

  it("reports a near-miss listing key as the misspelling it is", () => {
    for (const [typo, meant] of [
      ["nam", "name"],
      ["sourse", "source"],
      ["descripton", "description"],
      ["homepag", "homepage"],
      ["catagory", "category"],
    ] as const) {
      expect(entryNotes({ [typo]: "x" })).toContain(
        `listing 'reviewkit': '${typo}' looks like a misspelling of '${meant}'`,
      );
    }
  });

  it("says nothing about a foreign key that is not a near-miss of anything", () => {
    for (const key of ["license", "mcpServers", "author", "commands"]) {
      const notes = entryNotes({ [key]: "x" });
      expect(notes).toContain(`does not act on: ${key}`);
      expect(notes).not.toContain("looks like a misspelling");
    }
  });

  it("gives a short key a tighter budget than a long one, at the same edit distance", () => {
    const notes = entryNotes({ gome: 1, homepg: 1 });

    expect(notes).toContain("does not act on: gome, homepg");
    expect(notes).toContain("'homepg' looks like a misspelling of 'homepage'");
    expect(notes).not.toContain("'gome' looks like");
  });

  it("lists at most MAX_LISTED_KEYS names, and counts the rest", () => {
    const foreign: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) foreign[`a${String(i).padStart(2, "0")}`] = 1;

    const note = only(foreign).notes.find((line) => line.includes("does not act on"))!;
    const names = note.slice(note.indexOf("does not act on: ") + 17);

    expect(names.endsWith(" (+5 more)")).toBe(true);
    expect(names.replace(" (+5 more)", "").split(", ")).toHaveLength(MAX_LISTED_KEYS);
    expect(names).toContain("a00");
    expect(names).not.toContain("a20");
  });

  it("suggests only for the keys it actually listed", () => {
    const near: Record<string, unknown> = { homepag: 1 };
    for (let i = 0; i < 5; i++) near[`a${String(i)}`] = 1;
    expect(entryNotes(near)).toContain("'homepag' looks like a misspelling of 'homepage'");

    const buried: Record<string, unknown> = { homepag: 1 };
    for (let i = 0; i < MAX_LISTED_KEYS; i++) buried[`a${String(i).padStart(2, "0")}`] = 1;
    const notes = entryNotes(buried);
    expect(notes).toContain("(+1 more)");
    expect(notes).not.toContain("looks like a misspelling");
  });

  it("says nothing at all when there is nothing it does not act on", () => {
    expect(entryNotes()).toBe("");
    expect(read({ name: "acme", plugins: [] }).notes).toEqual([]);
  });
});

describe("marketplaceSchema: the truncations that keep a foreign document bounded", () => {
  function repeated(count: number, entry: unknown): Record<string, unknown> {
    return { name: "big", plugins: Array.from({ length: count }, () => entry) };
  }

  it("reads at most MAX_LISTINGS listings, and says how many it left", () => {
    const catalog = read(repeated(MAX_LISTINGS + 1, listing({ name: "p" })));

    expect(catalog.plugins).toHaveLength(MAX_LISTINGS);
    expect(catalog.notes.join("\n")).toContain(
      `marketplace: only the first ${String(MAX_LISTINGS)} of ${String(MAX_LISTINGS + 1)} ` +
        "listings were read",
    );
  });

  it("says nothing when the catalog sits exactly on the bound", () => {
    const catalog = read(repeated(MAX_LISTINGS, listing({ name: "p" })));

    expect(catalog.plugins).toHaveLength(MAX_LISTINGS);
    expect(catalog.notes.join("\n")).not.toContain("only the first");
  });

  it("keeps at most MAX_NOTES notes on the document, and counts the rest", () => {
    const catalog = read(repeated(MAX_NOTES + 10, 42));

    expect(catalog.plugins).toEqual([]);
    expect(catalog.notes).toHaveLength(MAX_NOTES + 1);
    expect(catalog.notes[MAX_NOTES]).toBe("(+10 more)");
    expect(catalog.notes[MAX_NOTES - 1]).toContain(`listing ${String(MAX_NOTES)} was dropped`);
  });

  it("leaves a note list that fits alone", () => {
    const catalog = read(repeated(MAX_NOTES, 42));

    expect(catalog.notes).toHaveLength(MAX_NOTES);
    expect(catalog.notes.join("\n")).not.toContain("more)");
  });

  it("keeps a listing's own note list bounded however hostile the document is", () => {
    const hostile: Record<string, unknown> = {};
    for (let i = 0; i < 3_000; i++) hostile[`nam${String(i)}`] = 1;

    const entry = only(hostile);

    expect(entry.notes.length).toBeLessThanOrEqual(MAX_NOTES + 1);
    expect(Math.max(...entry.notes.map((line) => line.length))).toBeLessThan(1_000);
  });
});

describe("marketplaceSchema: a whole catalog written in another host's dialect", () => {
  const foreign = {
    name: "example-catalog",
    metadata: { title: "Example Catalog" },
    owner: "example",
    plugins: [
      {
        name: "reviewkit",
        source: "https://github.com/o/reviewkit",
        interface: { displayName: "Review Kit", summary: "Structured review passes over a diff." },
        policy: { autoUpdate: true },
      },
      {
        name: "notekeeper",
        source: { source: "local", path: "plugins/notekeeper" },
        category: "writing",
      },
      { name: "shipper", source: { source: "registry" }, tagline: "Release checklists." },
      { name: "docs", source: "git@example.invalid:o/docs.git", path: "packages/docs" },
      42,
    ],
  };

  it("loses no listing it can read, and drops exactly the one it cannot", () => {
    const catalog = read(foreign);

    expect(catalog.plugins.map((entry) => entry.name)).toEqual([
      "reviewkit",
      "notekeeper",
      "shipper",
      "docs",
    ]);
    expect(catalog.notes.filter((line) => line.includes("was dropped"))).toHaveLength(1);
  });

  it("reads the catalog's title out of its own presentation block", () => {
    const catalog = read(foreign);

    expect(catalog.displayName).toBe("Example Catalog");
    expect(catalog.notes.join("\n")).toContain("keys Clarvis does not act on: owner");
    expect(catalog.notes.join("\n")).not.toContain("metadata");
  });

  it("offers only the git-backed listings for install", () => {
    const catalog = read(foreign);

    expect(catalog.plugins.filter((entry) => entry.installable).map((entry) => entry.name)).toEqual(
      ["reviewkit", "docs"],
    );
  });

  it("reads each listing's summary out of whatever key its dialect used", () => {
    const catalog = read(foreign);
    const byName = new Map(catalog.plugins.map((entry) => [entry.name, entry]));

    expect(byName.get("reviewkit")!.description).toBe("Structured review passes over a diff.");
    expect(byName.get("reviewkit")!.displayName).toBe("Review Kit");
    expect(byName.get("reviewkit")!.notes.join("\n")).toContain("does not act on: policy");
    expect(byName.get("reviewkit")!.notes.join("\n")).not.toContain("does not act on: interface");

    expect(byName.get("notekeeper")!.description).toBe(
      `${DEFAULT_ENTRY_DESCRIPTION} (category: writing)`,
    );
    expect(byName.get("shipper")!.description).toBe("Release checklists.");
    expect(byName.get("docs")!.description).toBe(DEFAULT_ENTRY_DESCRIPTION);
  });

  it("corrupting one listing costs exactly that listing", () => {
    const damaged = {
      ...foreign,
      plugins: foreign.plugins.map((entry, index) =>
        index === 3 ? { ...(entry as object), name: "NOT A NAME" } : entry,
      ),
    };
    const catalog = read(damaged);

    expect(catalog.plugins.map((entry) => entry.name)).toEqual([
      "reviewkit",
      "notekeeper",
      "shipper",
    ]);
    expect(catalog.notes.filter((line) => line.includes("was dropped"))).toHaveLength(2);
  });
});
