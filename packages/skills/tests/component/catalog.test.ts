import { describe, expect, it } from "bun:test";
import { renderSkillCatalog } from "../../src/catalog/index.ts";
import { makeInfo } from "../helpers/fixtures.ts";

describe("renderSkillCatalog", () => {
  it("renders a sorted markdown section of name + description", () => {
    const text = renderSkillCatalog([
      makeInfo({ name: "pdf", description: "Extract text from PDFs" }),
      makeInfo({ name: "git-commit", description: "Create a commit" }),
    ]);
    expect(text).toBe(
      "# Available skills\n\n" +
        "- **git-commit** — Create a commit\n" +
        "- **pdf** — Extract text from PDFs\n",
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
    expect(text).toBe("# Available skills\n\n- **listed** — shown\n");
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
});
