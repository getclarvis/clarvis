import { describe, expect, it } from "bun:test";
import { skillFrontmatterSchema } from "../../src/schema.ts";

describe("skillFrontmatterSchema", () => {
  it("accepts the minimal name + description frontmatter", () => {
    const parsed = skillFrontmatterSchema.safeParse({ name: "x", description: "y" });
    expect(parsed.success).toBe(true);
  });

  it("requires name", () => {
    const parsed = skillFrontmatterSchema.safeParse({ description: "y" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]?.path).toEqual(["name"]);
  });

  it("requires a non-empty description", () => {
    expect(skillFrontmatterSchema.safeParse({ name: "x", description: "  " }).success).toBe(false);
  });

  it("rejects a name with a path separator or whitespace", () => {
    expect(skillFrontmatterSchema.safeParse({ name: "a/b", description: "y" }).success).toBe(false);
    expect(skillFrontmatterSchema.safeParse({ name: "a b", description: "y" }).success).toBe(false);
  });

  it("accepts an agent naming a single segment, and trims it", () => {
    const parsed = skillFrontmatterSchema.safeParse({
      name: "x",
      description: "y",
      agent: "  code-reviewer  ",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.agent).toBe("code-reviewer");
  });

  it("accepts a plugin-qualified agent", () => {
    const parsed = skillFrontmatterSchema.safeParse({
      name: "x",
      description: "y",
      agent: "my-plugin:reviewer",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.agent).toBe("my-plugin:reviewer");
  });

  it("degrades a malformed agent to none instead of invalidating the whole skill", () => {
    const bad: unknown[] = ["   ", "", "a/b", "a b", ["one"], true, 7, "x".repeat(129)];
    for (const agent of bad) {
      const parsed = skillFrontmatterSchema.safeParse({ name: "x", description: "y", agent });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.agent).toBeUndefined();
    }
  });

  it("accepts the documented optional fields", () => {
    const parsed = skillFrontmatterSchema.safeParse({
      name: "x",
      description: "y",
      agent: "coder",
      version: "1.0.0",
      "allowed-tools": ["Read", "Grep"],
      "user-invocable": true,
      "argument-hint": "<arg>",
      license: "MIT",
      tools: "Read, Bash",
    });
    expect(parsed.success).toBe(true);
  });

  it("accepts allowed-tools as either an array or a string", () => {
    expect(
      skillFrontmatterSchema.safeParse({
        name: "x",
        description: "y",
        "allowed-tools": "Read,Grep",
      }).success,
    ).toBe(true);
  });

  it("keeps unknown keys via passthrough", () => {
    const parsed = skillFrontmatterSchema.safeParse({ name: "x", description: "y", extra: "kept" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as Record<string, unknown>).extra).toBe("kept");
  });
});

describe("display-only fields never decide whether a skill exists", () => {
  const base = { name: "s", description: "d" };

  it("reads an argument hint written as a string", () => {
    const parsed = skillFrontmatterSchema.parse({ ...base, "argument-hint": "[file]" });
    expect(parsed["argument-hint"]).toBe("[file]");
  });

  it("reads the list YAML makes of a bracketed hint, rather than losing the skill", () => {
    const parsed = skillFrontmatterSchema.parse({
      ...base,
      "argument-hint": ["files", "directories", "or a plugin"],
    });
    expect(parsed["argument-hint"]).toBe("files, directories, or a plugin");
  });

  it("degrades a hint it cannot read at all to none", () => {
    const parsed = skillFrontmatterSchema.parse({ ...base, "argument-hint": { odd: true } });
    expect(parsed["argument-hint"]).toBeUndefined();
    expect(parsed.name).toBe("s");
  });

  it("degrades an unreadable version or license the same way", () => {
    const parsed = skillFrontmatterSchema.parse({ ...base, version: 7, license: [] });
    expect(parsed.version).toBeUndefined();
    expect(parsed.license).toBeUndefined();
    expect(parsed.name).toBe("s");
  });

  it("still refuses a tool declaration it cannot read, which would widen the skill", () => {
    expect(skillFrontmatterSchema.safeParse({ ...base, tools: 7 }).success).toBe(false);
  });
});
