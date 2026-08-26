import { describe, expect, test } from "bun:test";

import { parseFrontmatter, readDescription, serializeDoc } from "../../src/frontmatter.ts";

describe("frontmatter", () => {
  test("parses description and tags, splitting the body off", () => {
    const doc = "---\ndescription: pinned via mise\ntags: [bun, infra]\n---\n\n# Bun\nBody here.";
    const { frontmatter, body } = parseFrontmatter(doc);
    expect(frontmatter.description).toBe("pinned via mise");
    expect(frontmatter.tags).toEqual(["bun", "infra"]);
    expect(body).toBe("# Bun\nBody here.");
  });

  test("tolerates a file with no frontmatter — whole text is the body", () => {
    const { frontmatter, body } = parseFrontmatter("# Just a heading\ntext");
    expect(frontmatter.description).toBe("");
    expect(frontmatter.tags).toEqual([]);
    expect(body).toBe("# Just a heading\ntext");
  });

  test("tolerates unterminated frontmatter without losing content", () => {
    const { body, unparsable } = parseFrontmatter("---\ndescription: oops\n# no closing fence");
    expect(body).toContain("# no closing fence");
    expect(unparsable).toBe(true);
  });

  test("flags only an unclosed block as unparsable", () => {
    expect(parseFrontmatter("---\ndescription: d\n---\nbody").unparsable).toBe(false);
    expect(parseFrontmatter("# no frontmatter at all").unparsable).toBe(false);
  });

  test("round-trips through serializeDoc, omitting empty tags", () => {
    const out = serializeDoc({ description: "a fact" }, "# T\nbody");
    expect(out).toBe("---\ndescription: a fact\n---\n\n# T\nbody\n");
    expect(readDescription(out)).toBe("a fact");
  });

  test("collapses newlines in a description so the frontmatter stays one line", () => {
    const out = serializeDoc({ description: "line one\nline two" }, "body");
    expect(out).toContain("description: line one line two");
    expect(readDescription(out)).toBe("line one line two");
  });
});

describe("unknown keys", () => {
  test("preserves an unrecognized key through a parse/serialize round trip", () => {
    // Regression: reindex's ensureDescription/ensureIntro call serializeDoc on
    // existing hand-written files, so dropping unknown keys destroyed them the
    // first time a file was repaired.
    const doc = "---\ndescription: d\nowner: evandro\nsource: handbook\n---\n\nbody";
    const parsed = parseFrontmatter(doc);
    expect(parsed.frontmatter.extra).toEqual(["owner: evandro", "source: handbook"]);
    const out = serializeDoc(parsed.frontmatter, parsed.body);
    expect(out).toContain("owner: evandro");
    expect(out).toContain("source: handbook");
    expect(parseFrontmatter(out).frontmatter.extra).toEqual(parsed.frontmatter.extra);
  });

  test("keeps unknown keys in their original order", () => {
    const doc = "---\nzeta: 1\ndescription: d\nalpha: 2\n---\n\nbody";
    expect(parseFrontmatter(doc).frontmatter.extra).toEqual(["zeta: 1", "alpha: 2"]);
  });

  test("omits extra entirely when everything was recognized", () => {
    expect(parseFrontmatter("---\ndescription: d\n---\nbody").frontmatter.extra).toBeUndefined();
  });

  test("is byte-stable across repeated serialization", () => {
    const doc = "---\ndescription: d\ntags: [a]\nowner: evandro\n---\n\nbody";
    const once = serializeDoc(parseFrontmatter(doc).frontmatter, "body");
    const twice = serializeDoc(parseFrontmatter(once).frontmatter, "body");
    expect(twice).toBe(once);
  });
});

describe("authority and pinned", () => {
  test("parses and round-trips the known values", () => {
    for (const authority of ["observed", "confirmed", "contested"] as const) {
      const doc = `---\ndescription: d\nauthority: ${authority}\npinned: true\n---\n\nbody`;
      const parsed = parseFrontmatter(doc);
      expect(parsed.frontmatter.authority).toBe(authority);
      expect(parsed.frontmatter.pinned).toBe(true);
      const out = serializeDoc(parsed.frontmatter, parsed.body);
      expect(parseFrontmatter(out).frontmatter.authority).toBe(authority);
      expect(parseFrontmatter(out).frontmatter.pinned).toBe(true);
    }
  });

  test("does not invent fields the document never declared", () => {
    const parsed = parseFrontmatter("---\ndescription: d\n---\n\nbody");
    expect(parsed.frontmatter.authority).toBeUndefined();
    expect(parsed.frontmatter.pinned).toBeUndefined();
    expect(serializeDoc(parsed.frontmatter, parsed.body)).not.toContain("authority");
    expect(serializeDoc(parsed.frontmatter, parsed.body)).not.toContain("pinned");
  });

  test("preserves an invalid authority verbatim rather than coercing it", () => {
    const parsed = parseFrontmatter("---\ndescription: d\nauthority: gospel\n---\n\nbody");
    expect(parsed.frontmatter.authority).toBeUndefined();
    expect(parsed.frontmatter.extra).toEqual(["authority: gospel"]);
    expect(serializeDoc(parsed.frontmatter, parsed.body)).toContain("authority: gospel");
  });

  test("preserves a non-boolean pinned verbatim rather than guessing", () => {
    const parsed = parseFrontmatter("---\ndescription: d\npinned: maybe\n---\n\nbody");
    expect(parsed.frontmatter.pinned).toBeUndefined();
    expect(parsed.frontmatter.extra).toEqual(["pinned: maybe"]);
  });

  test("accepts the usual boolean spellings", () => {
    for (const value of ["true", "yes", "on", "1"]) {
      expect(
        parseFrontmatter(`---\ndescription: d\npinned: ${value}\n---\nb`).frontmatter.pinned,
      ).toBe(true);
    }
    for (const value of ["false", "no", "off", "0"]) {
      expect(
        parseFrontmatter(`---\ndescription: d\npinned: ${value}\n---\nb`).frontmatter.pinned,
      ).toBe(false);
    }
  });

  test("emits keys in a fixed order", () => {
    const out = serializeDoc(
      { description: "d", tags: ["t"], authority: "confirmed", pinned: true, extra: ["x: 1"] },
      "body",
    );
    expect(out.split("\n").slice(0, 7)).toEqual([
      "---",
      "description: d",
      "tags: [t]",
      "authority: confirmed",
      "pinned: true",
      "x: 1",
      "---",
    ]);
  });
});

describe("block-form tags", () => {
  test("reads a YAML block list, which the inline parser used to drop", () => {
    const doc = "---\ndescription: d\ntags:\n  - bun\n  - infra\n---\n\nbody";
    expect(parseFrontmatter(doc).frontmatter.tags).toEqual(["bun", "infra"]);
  });

  test("normalizes a block list to inline form on write", () => {
    const doc = "---\ndescription: d\ntags:\n  - bun\n---\n\nbody";
    const parsed = parseFrontmatter(doc);
    expect(serializeDoc(parsed.frontmatter, parsed.body)).toContain("tags: [bun]");
  });

  test("stops absorbing list items once another key starts", () => {
    const doc = "---\ntags:\n  - bun\ndescription: d\n---\n\nbody";
    const parsed = parseFrontmatter(doc);
    expect(parsed.frontmatter.tags).toEqual(["bun"]);
    expect(parsed.frontmatter.description).toBe("d");
  });
});
