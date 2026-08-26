import { expect, test } from "bun:test";
import { stripDocChrome } from "../../src/views/Prose.tsx";

const DOC = [
  "---",
  "description: Bun commands",
  "tags: [bun]",
  "---",
  "",
  "# Bun",
  "",
  "Use mise.",
  "",
  "<!-- reindex:begin -->",
  "- [infra](infra/TOPIC.md)",
  "<!-- reindex:end -->",
  "",
].join("\n");

test("stripDocChrome drops frontmatter and reindex markers but keeps the navigation links", () => {
  const out = stripDocChrome(DOC);
  expect(out).not.toContain("description:");
  expect(out).not.toContain("reindex");
  expect(out.startsWith("# Bun")).toBe(true);
  expect(out).toContain("- [infra](infra/TOPIC.md)");
});

test("stripDocChrome leaves a document without chrome untouched", () => {
  expect(stripDocChrome("# Plain\n\nBody.")).toBe("# Plain\n\nBody.");
});

test("a horizontal rule mid-document is not mistaken for frontmatter", () => {
  const doc = "# Title\n\n---\n\nBelow the rule.";
  expect(stripDocChrome(doc)).toBe(doc);
});
