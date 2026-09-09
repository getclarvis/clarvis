import { describe, expect, it } from "bun:test";
import { MAX_SKILL_CATALOG_CHARS, renderSkillCatalog } from "../../src/catalog/index.ts";
import { makeInfo } from "../helpers/fixtures.ts";

describe("renderSkillCatalog", () => {
  it.each([false, true])(
    "describes remote access without a filesystem path, compact=%s",
    (compact) => {
      const text = renderSkillCatalog([
        makeInfo({
          resourceAccess: "remote",
          path: "runtime-skill:demo",
          description: compact ? "long".repeat(MAX_SKILL_CATALOG_CHARS) : "Remote skill",
        }),
      ]);
      expect(text).toContain("remote; load by name; resources via read_skill_resource");
      expect(text).not.toContain("path:");
      expect(text).not.toContain("runtime-skill:");
      expect(text.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
    },
  );

  it("identifies embedded instructions without advertising a filesystem path", () => {
    const text = renderSkillCatalog([makeInfo({ source: "builtin", path: "builtin:setup" })]);
    expect(text).toContain("builtin; load by name");
    expect(text).not.toContain("path:");
  });

  it("keeps builtin guidance discoverable when external entries overflow the catalog", () => {
    const external = Array.from({ length: 200 }, (_, index) =>
      makeInfo({ name: `a-${String(index)}`, description: "External skill. ".repeat(50) }),
    );
    const text = renderSkillCatalog([
      ...external,
      makeInfo({ name: "z-configure", source: "builtin", path: "builtin:z-configure" }),
    ]);
    expect(text.split("\n")[2]).toBe("- **z-configure** (builtin; load by name)");
    expect(text.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
  });
  it("renders a sorted markdown section of name + description", () => {
    const text = renderSkillCatalog([
      makeInfo({ name: "pdf", description: "Extract text from PDFs" }),
      makeInfo({ name: "git-commit", description: "Create a commit" }),
    ]);
    expect(text).toBe(
      "# Available skills\n\n" +
        "- **git-commit** — Create a commit (path: /roots/skills/git-commit/SKILL.md)\n" +
        "- **pdf** — Extract text from PDFs (path: /roots/skills/pdf/SKILL.md)\n",
    );
  });

  it("returns an empty string when there are no skills", () => {
    expect(renderSkillCatalog([])).toBe("");
  });

  it("withholds a catalog-suppressed skill while keeping the rest", () => {
    const text = renderSkillCatalog([
      makeInfo({ name: "listed", description: "shown" }),
      makeInfo({ name: "withheld", description: "hidden", catalogSuppressed: true }),
    ]);
    expect(text).toBe(
      "# Available skills\n\n" + "- **listed** — shown (path: /roots/skills/listed/SKILL.md)\n",
    );
  });

  it("lists a skill that is merely not user-invocable", () => {
    // The two axes are independent: `user-invocable` filters the slash listing a
    // user chooses from, and never the catalog the model reads.
    const text = renderSkillCatalog([
      makeInfo({ name: "internal", description: "d", userInvocable: false }),
    ]);
    expect(text).toContain("- **internal** — d");
  });

  it("returns an empty string when every skill is suppressed", () => {
    expect(renderSkillCatalog([makeInfo({ name: "a", catalogSuppressed: true })])).toBe("");
  });

  it("leaves the caller's array untouched", () => {
    const skills = [makeInfo({ name: "b" }), makeInfo({ name: "a" })];
    renderSkillCatalog(skills);
    expect(skills.map((s) => s.name)).toEqual(["b", "a"]);
  });

  it("keeps one hundred compact entries addressable inside the catalog bound", () => {
    const skills = Array.from({ length: 100 }, (_, index) =>
      makeInfo({
        name: `skill-${String(index).padStart(3, "0")}`,
        description: "A very detailed description. ".repeat(20),
      }),
    );

    const text = renderSkillCatalog(skills);

    expect(text.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
    expect(text).not.toContain("additional skills omitted from this bounded catalog");
    expect(text).toContain("**skill-099**");
    expect(text).not.toContain("A very detailed description");
  });

  it("drops descriptions before omitting a deterministic tail within the catalog bound", () => {
    const skills = Array.from({ length: 200 }, (_, index) =>
      makeInfo({
        name: `skill-${String(index).padStart(3, "0")}`,
        description: "A very detailed description. ".repeat(20),
      }),
    );

    const text = renderSkillCatalog(skills);

    expect(text.length).toBeLessThanOrEqual(MAX_SKILL_CATALOG_CHARS);
    expect(text).toContain("additional skills omitted from this bounded catalog");
    expect(text).toContain("**skill-000**");
    expect(text).not.toContain("A very detailed description");
    expect(text).not.toContain("**skill-199**");
  });

  it("returns no partial entry when one compact line alone exceeds the hard bound", () => {
    const oversized = "x".repeat(MAX_SKILL_CATALOG_CHARS);
    expect(renderSkillCatalog([makeInfo({ name: oversized, path: `/${oversized}` })])).toBe("");
  });
});
