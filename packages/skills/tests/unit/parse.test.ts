import { describe, expect, it } from "bun:test";
import { normalizeTools, parseSkill, splitFrontmatter } from "../../src/parse.ts";
import { SkillError } from "../../src/errors.ts";

function skillMd(frontmatter: string, body = "Hello."): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

function skillError(fn: () => unknown): SkillError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SkillError) return e;
    throw e;
  }
  throw new Error("expected parseSkill to throw a SkillError");
}

describe("parseSkill", () => {
  it("reads the frontmatter and the trimmed markdown body", () => {
    const parsed = parseSkill(
      skillMd("name: git-commit\ndescription: Create a commit", "\n  body text\n"),
    );
    expect(parsed.frontmatter.name).toBe("git-commit");
    expect(parsed.frontmatter.description).toBe("Create a commit");
    expect(parsed.body).toBe("body text");
  });

  it("preserves unknown frontmatter keys via passthrough", () => {
    const parsed = parseSkill(skillMd("name: x\ndescription: y\ncustom: 42\nnested: {a: 1}"));
    expect((parsed.frontmatter as Record<string, unknown>).custom).toBe(42);
    expect((parsed.frontmatter as Record<string, unknown>).nested).toEqual({ a: 1 });
  });

  it("strips a leading UTF-8 BOM before parsing", () => {
    const parsed = parseSkill("\uFEFF" + skillMd("name: x\ndescription: y"));
    expect(parsed.frontmatter.name).toBe("x");
  });

  it("accepts CRLF line endings in the frontmatter fence", () => {
    const parsed = parseSkill("---\r\nname: x\r\ndescription: y\r\n---\r\nbody");
    expect(parsed.frontmatter.name).toBe("x");
    expect(parsed.body).toBe("body");
  });

  it("rejects a frontmatter block with no closing fence", () => {
    expect(() => parseSkill("---\nname: x\ndescription: y\n")).toThrow(SkillError);
    const err = skillError(() => parseSkill("---\nname: x\n"));
    expect(err.code).toBe("invalid_skill");
    expect(err.message).toMatch(/closing '---' fence/);
  });

  it("rejects a file with no frontmatter at all (missing required fields)", () => {
    expect(() => parseSkill("just some markdown, no frontmatter")).toThrow(SkillError);
  });

  it("rejects invalid YAML in the frontmatter", () => {
    const err = skillError(() => parseSkill(skillMd("name: x\ndescription: [unterminated")));
    expect(err.code).toBe("invalid_skill");
    expect(err.message).toMatch(/invalid YAML/);
  });

  it("rejects a skill missing its name", () => {
    const err = skillError(() => parseSkill(skillMd("description: only a description")));
    expect(err.code).toBe("invalid_skill");
    expect(err.fields.at).toBe("name");
  });

  it("rejects a skill missing its description", () => {
    const err = skillError(() => parseSkill(skillMd("name: x")));
    expect(err.code).toBe("invalid_skill");
    expect(err.fields.at).toBe("description");
  });

  it("rejects a name that contains a path separator", () => {
    expect(() => parseSkill(skillMd("name: a/b\ndescription: y"))).toThrow(SkillError);
  });

  it("rejects frontmatter that parses to a non-object scalar", () => {
    const err = skillError(() => parseSkill("---\n42\n---\nbody"));
    expect(err.code).toBe("invalid_skill");
    expect(err.fields.at).toBe("");
  });
});

describe("splitFrontmatter", () => {
  it("returns an empty body-less document as raw when there is no fence", () => {
    const out = splitFrontmatter("no fence here");
    expect(out.data).toEqual({});
    expect(out.body).toBe("no fence here");
  });

  it("treats an empty frontmatter block as empty data", () => {
    const out = splitFrontmatter("---\n\n---\nbody");
    expect(out.data).toEqual({});
    expect(out.body).toBe("body");
  });

  it("treats a comment-only frontmatter block as empty data", () => {
    const out = splitFrontmatter("---\n# only a comment\n---\nbody");
    expect(out.data).toEqual({});
  });
});

describe("normalizeTools", () => {
  it("returns an empty array when undefined", () => {
    expect(normalizeTools(undefined)).toEqual([]);
  });

  it("trims and drops blanks in a YAML array, just like the string form", () => {
    expect(normalizeTools(["Read", "", " Grep "])).toEqual(["Read", "Grep"]);
  });

  it("returns a fresh array so the result never aliases the frontmatter", () => {
    const input = ["Read", "Grep"];
    const out = normalizeTools(input);
    expect(out).toEqual(["Read", "Grep"]);
    expect(out).not.toBe(input);
  });

  it("splits and trims a comma-separated string, dropping blanks", () => {
    expect(normalizeTools("Read, Grep , ,Bash")).toEqual(["Read", "Grep", "Bash"]);
  });
});

describe("frontmatter a strict YAML parse rejects", () => {
  it("recovers a plain scalar whose prose contains a colon", () => {
    const { data } = splitFrontmatter(
      skillMd("name: incident-response\ndescription: Five phases: detect, contain, diagnose."),
    );
    expect(data).toEqual({
      name: "incident-response",
      description: "Five phases: detect, contain, diagnose.",
    });
  });

  it("keeps a quoted value's own parsing rather than re-quoting it", () => {
    const { data } = splitFrontmatter(
      skillMd('name: a\ndescription: "already: quoted"\nbad: nested: colon'),
    );
    expect(data).toMatchObject({ description: "already: quoted", bad: "nested: colon" });
  });

  it("recovers a flow sequence beside a colon-bearing scalar", () => {
    const { data } = splitFrontmatter(
      skillMd("name: a\ndescription: Use when: always\nallowed-tools: [read_file, grep]"),
    );
    expect(data).toMatchObject({
      description: "Use when: always",
      "allowed-tools": ["read_file", "grep"],
    });
  });

  it("still refuses frontmatter that is not a flat mapping", () => {
    expect(() =>
      splitFrontmatter(skillMd("name: a\nnested:\n  - one: two: three\n  - four")),
    ).toThrow(SkillError);
  });

  it("leaves a valid document untouched, including a genuine nested mapping", () => {
    const { data } = splitFrontmatter(skillMd("name: a\nmeta:\n  owner: platform"));
    expect(data).toEqual({ name: "a", meta: { owner: "platform" } });
  });
});
