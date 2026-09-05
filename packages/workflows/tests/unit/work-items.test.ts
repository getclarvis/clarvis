import { describe, expect, test } from "bun:test";

import { WORKFLOW_LIMITS } from "../../src/limits.ts";
import { buildRunWorkItemsTool, toWorkItem, workItemBrief } from "../../src/work-items.ts";

const VALID = {
  id: "read-parser",
  title: "Read parser",
  goal: "Read the parser",
  files: ["src/parser.ts"],
  dependencies: [],
  mutation: false,
};

describe("toWorkItem", () => {
  test("accepts the complete wire shape without changing it", () => {
    expect(toWorkItem(VALID)).toEqual(VALID);
  });

  test.each([
    ["a non-object", "nope"],
    ["an empty id", { ...VALID, id: "" }],
    ["an empty title", { ...VALID, title: "" }],
    ["a multiline title", { ...VALID, title: "Read\nparser" }],
    ["an oversized title", { ...VALID, title: "x".repeat(61) }],
    ["an empty goal", { ...VALID, goal: "" }],
    ["a non-boolean mutation", { ...VALID, mutation: "yes" }],
    ["non-string files", { ...VALID, files: [7] }],
    ["non-string dependencies", { ...VALID, dependencies: [7] }],
    [
      "too many files",
      { ...VALID, files: Array(WORKFLOW_LIMITS.filesPerWorkItem + 1).fill("src/x.ts") },
    ],
    [
      "too many dependencies",
      { ...VALID, dependencies: Array(WORKFLOW_LIMITS.dependenciesPerWorkItem + 1).fill("x") },
    ],
    ["an oversized id", { ...VALID, id: "x".repeat(WORKFLOW_LIMITS.identifierChars + 1) }],
    ["an oversized goal", { ...VALID, goal: "x".repeat(WORKFLOW_LIMITS.textChars + 1) }],
    ["an oversized path", { ...VALID, files: ["x".repeat(WORKFLOW_LIMITS.pathChars + 1)] }],
  ])("rejects %s", (_label, value) => {
    expect(toWorkItem(value)).toBeNull();
  });
});

describe("workItemBrief", () => {
  test("renders shared context, file scope and a mutating posture", () => {
    const text = workItemBrief(
      { ...VALID, files: ["src/a.ts", "src/b.ts"], mutation: true },
      "Audit the parser.",
    );
    expect(text).toContain("Audit the parser.");
    expect(text).toContain("Read the parser");
    expect(text).toContain("Files in scope for this item: src/a.ts, src/b.ts.");
    expect(text).toContain("may modify the workspace");
  });

  test("renders an unscoped read-only item without inventing a prefix", () => {
    const text = workItemBrief({ ...VALID, files: [] });
    expect(text).toContain("No files were declared in scope");
    expect(text).toContain("read-only: do not modify the workspace");
    expect(text).not.toContain("Audit");
  });

  test("does not give an unscoped writer an empty allowed file set or global isolation", () => {
    const text = workItemBrief({ ...VALID, files: [], mutation: true });
    expect(text).toContain("within its task scope");
    expect(text).toContain("alone within this batch, not isolated from unrelated work");
    expect(text).not.toContain("stay within the files above");
  });
});

describe("buildRunWorkItemsTool", () => {
  test("adds the profile selector only when profiles exist", () => {
    const bare = buildRunWorkItemsTool().inputSchema.properties as unknown as {
      items: {
        maxItems: number;
        items: {
          properties: {
            files: { maxItems: number };
            dependencies: { maxItems: number };
          };
        };
      };
      profile?: unknown;
    };
    expect(bare.profile).toBeUndefined();
    expect(buildRunWorkItemsTool().inputSchema.required).toEqual(["items"]);
    expect(bare.items.maxItems).toBe(WORKFLOW_LIMITS.workItems);
    expect(bare.items.items.properties.files.maxItems).toBe(WORKFLOW_LIMITS.filesPerWorkItem);
    expect(bare.items.items.properties.dependencies.maxItems).toBe(
      WORKFLOW_LIMITS.dependenciesPerWorkItem,
    );

    const withProfiles = buildRunWorkItemsTool([
      { name: "explorer", description: "reads" },
      { name: "implementer" },
    ]).inputSchema.properties as Record<string, { enum?: string[]; description?: string }>;
    expect(withProfiles.profile?.enum).toEqual(["explorer", "implementer"]);
    expect(withProfiles.profile?.description).toContain("explorer: reads");
    expect(withProfiles.profile?.description).toContain("implementer: (no description)");
  });
});
