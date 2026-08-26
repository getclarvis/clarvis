import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSkillSidecar } from "../../src/sidecar.ts";
import { MAX_SKILL_SHORT_DESCRIPTION_CHARS } from "../../src/limits.ts";
import { captureWarnings } from "../helpers/fixtures.ts";

describe("readSkillSidecar", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clarvis-skills-sidecar-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function write(text: string, name = "harness.yaml"): string {
    const file = path.join(dir, name);
    writeFileSync(file, text);
    return file;
  }

  function read(text: string): ReturnType<typeof readSkillSidecar> {
    const cap = captureWarnings();
    return readSkillSidecar(write(text), cap);
  }

  describe("presentation", () => {
    it("reads every presentation field", () => {
      const sidecar = read(
        [
          "display-name: Release Notes",
          "short-description: Notes from a commit range.",
          "icon:",
          "  light: assets/light.svg",
          "  dark: assets/dark.svg",
          'color: "#3B82F6"',
          "default-prompt: Draft the notes.",
        ].join("\n"),
      );
      expect(sidecar?.presentation).toEqual({
        displayName: "Release Notes",
        shortDescription: "Notes from a commit range.",
        icons: { light: "assets/light.svg", dark: "assets/dark.svg" },
        color: "#3b82f6",
        starterPrompt: "Draft the notes.",
      });
    });

    it("matches each concept by shape, across the spellings producers write", () => {
      const snake = read(
        [
          "display_name: A",
          "short_description: B",
          "brand_color: '#abc'",
          "default_prompt: C",
        ].join("\n"),
      );
      const camel = read(
        ["displayName: A", "shortDescription: B", "brandColor: '#abc'", "defaultPrompt: C"].join(
          "\n",
        ),
      );
      expect(snake?.presentation).toEqual({
        displayName: "A",
        shortDescription: "B",
        color: "#abc",
        starterPrompt: "C",
      });
      expect(camel?.presentation).toEqual(snake?.presentation);
    });

    it("accepts the alternate title/summary/colour/starter spellings", () => {
      const sidecar = read(
        ["title: A", "summary: B", "colour: '#ABCDEF'", "starter-prompt: C"].join("\n"),
      );
      expect(sidecar?.presentation).toEqual({
        displayName: "A",
        shortDescription: "B",
        color: "#abcdef",
        starterPrompt: "C",
      });
    });

    it("omits the presentation bucket entirely when nothing presentational is declared", () => {
      expect(read("policy:\n  implicit-invocation: true")?.presentation).toBeUndefined();
    });

    it("discards a non-string, blank or over-long value rather than truncating it", () => {
      const long = "x".repeat(MAX_SKILL_SHORT_DESCRIPTION_CHARS + 1);
      const sidecar = read(
        ["display-name: [a, b]", "short-description: |", `  ${long}`, "default-prompt: '   '"].join(
          "\n",
        ),
      );
      expect(sidecar?.presentation).toBeUndefined();
    });

    it("skips a null value and takes the next accepted spelling", () => {
      expect(read("display-name: ~\ndisplay_name: Second")?.presentation).toEqual({
        displayName: "Second",
      });
    });
  });

  describe("icons", () => {
    it("serves both themes from a single path", () => {
      expect(read("icon: ./assets/one.svg")?.presentation?.icons).toEqual({
        light: "assets/one.svg",
        dark: "assets/one.svg",
      });
    });

    it("reads the `icons` spelling and a `default` slot", () => {
      expect(read("icons:\n  default: a.svg")?.presentation?.icons).toEqual({ light: "a.svg" });
    });

    it("keeps a dark-only declaration", () => {
      expect(read("icon:\n  dark: d.svg")?.presentation?.icons).toEqual({ dark: "d.svg" });
    });

    it.each([
      ["absolute", "/etc/passwd"],
      ["parent-relative", "../../etc/passwd"],
      ["drive-qualified", "C:/windows/system32"],
      ["backslash-separated", "assets\\..\\..\\secret.svg"],
      ["self-referential only", "./."],
    ])("refuses an icon path that could escape the skill directory (%s)", (_label, value) => {
      expect(read(`icon: "${value}"`)?.presentation).toBeUndefined();
    });

    it("refuses a non-mapping, non-string icon declaration", () => {
      expect(read("icon:\n  - a.svg")?.presentation).toBeUndefined();
    });

    it("refuses a mapping whose every slot is unusable", () => {
      expect(read("icon:\n  light: /abs.svg\n  dark: 7")?.presentation).toBeUndefined();
    });
  });

  describe("colour", () => {
    it.each(["rgb", "not-a-colour", "#12345", "rgb(1,2,3)"])(
      "discards a colour that is not hex notation (%s)",
      (value) => {
        expect(read(`color: "${value}"`)?.presentation).toBeUndefined();
      },
    );
  });

  describe("catalog suppression", () => {
    it("suppresses when the policy block opts out of implicit invocation", () => {
      expect(read("policy:\n  implicit-invocation: false")?.catalogSuppressed).toBe(true);
    });

    it("does not suppress when the policy block opts in", () => {
      expect(read("policy:\n  implicit_invocation: true")?.catalogSuppressed).toBe(false);
    });

    it("suppresses on an explicit hide flag", () => {
      expect(read("policy:\n  hide-from-catalog: true")?.catalogSuppressed).toBe(true);
      expect(read("policy:\n  hidden: true")?.catalogSuppressed).toBe(true);
      expect(read("policy:\n  hidden: false")?.catalogSuppressed).toBe(false);
    });

    it("reads the flags at the top level when there is no policy block", () => {
      expect(read("implicitInvocation: false")?.catalogSuppressed).toBe(true);
      expect(read("hideFromCatalog: true")?.catalogSuppressed).toBe(true);
      expect(read("invocation:\n  implicit-invocation: false")?.catalogSuppressed).toBe(true);
    });

    it("lets the policy block decide even when the top level disagrees", () => {
      expect(read("hidden: true\npolicy:\n  implicit-invocation: true")?.catalogSuppressed).toBe(
        false,
      );
    });

    it("ignores a non-boolean flag and a non-mapping policy block", () => {
      expect(read("policy: nope\nhidden: 'yes'")?.catalogSuppressed).toBe(false);
      expect(read("policy:\n  - a\nhidden: null")?.catalogSuppressed).toBe(false);
    });

    it("is false when the sidecar says nothing about it", () => {
      expect(read("display-name: A")?.catalogSuppressed).toBe(false);
    });
  });

  describe("degradation", () => {
    it("degrades unparseable YAML to no sidecar, with a warning", () => {
      const cap = captureWarnings();
      const file = write("display-name: [unterminated\n  - nope\n");
      expect(readSkillSidecar(file, cap)).toBeUndefined();
      expect(cap.warnings.join("")).toMatch(/ignoring unreadable skill sidecar/);
      expect(cap.events("skill.sidecar_invalid")[0]?.fields).toMatchObject({
        file,
        reason: "unparseable",
      });
    });

    it("degrades a missing file to no sidecar, with a warning", () => {
      const cap = captureWarnings();
      expect(readSkillSidecar(path.join(dir, "absent.yaml"), cap)).toBeUndefined();
      expect(cap.warnings.join("")).toMatch(/ignoring unreadable skill sidecar/);
      const [record] = cap.events("skill.sidecar_invalid");
      expect(record?.level).toBe("warn");
      expect(record?.fields).toMatchObject({ reason: "unreadable" });
    });

    it.each([
      ["a scalar", "just a string"],
      ["a sequence", "- a\n- b"],
      ["an empty document", ""],
    ])("degrades %s to no sidecar, with a warning", (_label, text) => {
      const cap = captureWarnings();
      expect(readSkillSidecar(write(text), cap)).toBeUndefined();
      expect(cap.warnings.join("")).toMatch(/expected a mapping of fields/);
      expect(cap.events("skill.sidecar_invalid")[0]?.fields).toMatchObject({
        reason: "not_a_mapping",
      });
    });

    it("defaults its warning sink so a caller may omit one", () => {
      expect(() => readSkillSidecar(path.join(dir, "absent.yaml"))).not.toThrow();
    });
  });
});

describe("readSkillSidecar against the shapes producers actually write", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "clarvis-skills-observed-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function read(text: string): ReturnType<typeof readSkillSidecar> {
    const file = path.join(dir, "harness.yaml");
    writeFileSync(file, text);
    const cap = captureWarnings();
    return readSkillSidecar(file, cap);
  }

  it("reads presentation nested under a block, which is where producers put it", () => {
    const sidecar = read(
      [
        "interface:",
        '  display_name: "Review Agent"',
        '  short_description: "Find actionable bugs in code changes"',
        '  default_prompt: "Use $review-agent to review the requested changes."',
      ].join("\n"),
    );

    expect(sidecar?.presentation?.displayName).toBe("Review Agent");
    expect(sidecar?.presentation?.shortDescription).toBe("Find actionable bugs in code changes");
    expect(sidecar?.presentation?.starterPrompt).toContain("$review-agent");
  });

  it("suppresses the catalog from the prefixed spelling of the opt-out", () => {
    const sidecar = read(["policy:", "  allow_implicit_invocation: false"].join("\n"));

    expect(sidecar?.catalogSuppressed).toBe(true);
  });

  it("leaves the catalog alone when the same flag permits implicit invocation", () => {
    const sidecar = read(["policy:", "  allow_implicit_invocation: true"].join("\n"));

    expect(sidecar?.catalogSuppressed).toBe(false);
  });

  it("takes a sized icon as one icon serving both themes, preferring the smaller", () => {
    const sidecar = read(
      [
        "interface:",
        '  icon_small: "./assets/small.svg"',
        '  icon_large: "./assets/large.png"',
      ].join("\n"),
    );

    expect(sidecar?.presentation?.icons).toEqual({
      light: "assets/small.svg",
      dark: "assets/small.svg",
    });
  });

  it("falls back to the root for a field the block does not carry", () => {
    const sidecar = read(
      ["interface:", '  display_name: "Nested"', 'brand_color: "#3B82F6"'].join("\n"),
    );

    expect(sidecar?.presentation?.displayName).toBe("Nested");
    expect(sidecar?.presentation?.color).toBe("#3b82f6");
  });
});
